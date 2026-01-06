// src/services/whatsapp/state.manager.js

/**
 * 🗂️ Gestor de Estados
 *
 * Responsabilidad:
 * - Sincronizar estados con Redis
 * - Sincronizar estados con Laravel (vía batch)
 * - Gestionar cache local de sesiones activas
 */

class StateManager {
  constructor(cacheManager, batchQueueManager, logger, config = {}) {
    this.cacheManager = cacheManager;
    this.batchQueueManager = batchQueueManager;
    this.logger = logger;
    this.config = config;

    // Cache local de estado de sesión
    this.sessionActiveCache = new Map(); // sessionId → { active, timestamp }
    this.SESSION_ACTIVE_CACHE_TTL = 30000; // 30s
    this.lifecycleCacheLimit = config?.lifecycle?.cacheLimit || 50;
  }

  /**
   * 📝 Sincroniza estado en Redis
   */
  async syncStateToRedis(sessionId, estado) {
    await this.cacheManager.setStatus(sessionId, estado);
    this.logger.debug("📝 Estado sincronizado en Redis", { sessionId, estado });
  }

  /**
   * 📤 Sincroniza estado en Laravel (vía batch)
   */
  syncStateToLaravel(sessionId, estado, priority = "normal") {
    this.batchQueueManager.addStatus(sessionId, estado, priority);
    this.logger.debug("📤 Estado encolado para Laravel", {
      sessionId,
      estado,
      priority,
    });
  }

  /**
   * 🔄 Actualiza estado completo (Redis + Laravel + cache)
   */
  async updateSessionStatus(sessionId, estado, priority = "normal") {
    await this.syncStateToRedis(sessionId, estado);
    this.syncStateToLaravel(sessionId, estado, priority);

    const isActive = estado === "active";
    this.setLocalSessionState(sessionId, estado, {
      active: isActive,
      reconnectEligible: estado === "active" || estado === "connecting",
    });

    this.logger.info(`✅ Estado actualizado a ${estado}`, { sessionId });
  }

  /**
   * 🧹 Limpia cache de sesión
   */
  clearSessionCache(sessionId) {
    this.sessionActiveCache.delete(sessionId);
    this.logger.debug("🧹 Cache de sesión limpiado", { sessionId });
  }

  /**
   * 🔍 Verifica si sesión está en cache local
   */
  getFromLocalCache(sessionId, options = {}) {
    const normalizedOptions =
      typeof options === "boolean"
        ? { skipForReconnect: options, forReconnect: false }
        : options;

    if (normalizedOptions.skipForReconnect) {
      return null; // No usar cache durante reconexión
    }

    const cached = this.sessionActiveCache.get(sessionId);

    if (
      cached &&
      Date.now() - cached.timestamp < this.SESSION_ACTIVE_CACHE_TTL
    ) {
      return normalizedOptions.forReconnect
        ? cached.reconnectEligible
        : cached.active;
    }

    return null;
  }

  /**
   * 📊 Obtiene estado desde Redis
   */
  async getStatusFromRedis(sessionId) {
    return await this.cacheManager.getStatus(sessionId);
  }

  /**
   * 🧠 Cachea estado local completo
   */
  setLocalSessionState(sessionId, status, flags = {}) {
    this.sessionActiveCache.set(sessionId, {
      status,
      active: Boolean(flags.active),
      reconnectEligible: Boolean(flags.reconnectEligible),
      timestamp: Date.now(),
    });
  }

  getStatusSnapshot(sessionId) {
    const cached = this.sessionActiveCache.get(sessionId);
    if (!cached) {
      return null;
    }
    return {
      status: cached.status,
      active: cached.active,
      reconnectEligible: cached.reconnectEligible,
      updatedAt: cached.timestamp,
    };
  }

  getCachedStatus(sessionId) {
    return this.sessionActiveCache.get(sessionId)?.status || null;
  }

  async recordTransition(sessionId, event, meta = {}, priority = "normal") {
    const payload = {
      event,
      meta,
      timestamp: Date.now(),
    };

    await this.cacheManager.pushLifecycleEvent(
      sessionId,
      payload,
      this.lifecycleCacheLimit
    );

    if (typeof this.batchQueueManager.addLifecycleEvent === "function") {
      this.batchQueueManager.addLifecycleEvent(
        sessionId,
        event,
        meta,
        priority
      );
    }

    this.logger.debug(`🔁 Evento ${event}`, { sessionId, meta });
  }

  async incrementCleanupMiss(sessionId) {
    return await this.cacheManager.incrementCleanupMiss(sessionId);
  }

  async resetCleanupMiss(sessionId) {
    await this.cacheManager.resetCleanupMiss(sessionId);
  }

  async updateHeartbeat(sessionId, timestamp = Date.now()) {
    await this.cacheManager.setHeartbeat(sessionId, timestamp);
    return timestamp;
  }

  async getLastHeartbeat(sessionId) {
    return await this.cacheManager.getHeartbeat(sessionId);
  }
}

module.exports = StateManager;
