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
  constructor(cacheManager, batchQueueManager, logger) {
    this.cacheManager = cacheManager;
    this.batchQueueManager = batchQueueManager;
    this.logger = logger;

    // Cache local de estado de sesión
    this.sessionActiveCache = new Map(); // sessionId → { active, timestamp }
    this.SESSION_ACTIVE_CACHE_TTL = 30000; // 30s
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
    this.sessionActiveCache.set(sessionId, {
      active: isActive,
      timestamp: Date.now(),
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
  getFromLocalCache(sessionId, skipForReconnect = false) {
    if (skipForReconnect) {
      return null; // No usar cache durante reconexión
    }

    const cached = this.sessionActiveCache.get(sessionId);

    if (
      cached &&
      Date.now() - cached.timestamp < this.SESSION_ACTIVE_CACHE_TTL
    ) {
      return cached.active;
    }

    return null;
  }

  /**
   * 📊 Obtiene estado desde Redis
   */
  async getStatusFromRedis(sessionId) {
    return await this.cacheManager.getStatus(sessionId);
  }
}

module.exports = StateManager;
