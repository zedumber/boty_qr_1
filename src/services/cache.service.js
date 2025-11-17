/**
 * 💾 Módulo de Gestión de Cache
 *
 * Gestiona:
 * - Cache en Redis para estado de sesiones
 * - Reducción de consultas a Laravel
 * - TTL inteligente por tipo de dato
 * - Invalidación selectiva de cache
 */

class CacheManager {
  constructor(redis, logger) {
    this.redis = redis;
    this.logger = logger;

    // TTL por tipo de dato (en segundos)
    this.ttl = {
      qr: 60, // QR expira en 60s
      status: 120, // Estado expira en 120s
      connection: 30, // Conexión expira en 30s
      session: 300, // Sesión expira en 5 minutos
    };
  }

  /**
   * 🔑 Construye las claves de cache
   */
  keys = {
    qr: (sessionId) => `session:${sessionId}:qr`,
    status: (sessionId) => `session:${sessionId}:status`,
    connection: (sessionId) => `session:${sessionId}:connection`,
    session: (sessionId) => `session:${sessionId}:info`,
  };

  /**
   * 💾 Obtiene valor del cache
   */
  async get(key) {
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        this.logger.debug("✅ Cache HIT", { key });
        return JSON.parse(cached);
      }
      return null;
    } catch (error) {
      this.logger.error("❌ Error obteniendo cache", error, { key });
      return null;
    }
  }

  /**
   * 🔒 Establece valor en cache con TTL
   */
  async set(key, value, type = "default") {
    try {
      const ttl = this.ttl[type] || this.ttl.session;
      await this.redis.setex(key, ttl, JSON.stringify(value));
      this.logger.debug("💾 Cache SET", { key, ttl });
      return true;
    } catch (error) {
      this.logger.error("❌ Error estableciendo cache", error, { key });
      return false;
    }
  }

  /**
   * 🔄 Obtiene o genera valor si no existe en cache
   */
  async getOrSet(key, fetcher, type = "default") {
    try {
      // Intentar obtener del cache
      let cached = await this.get(key);
      if (cached) {
        return cached;
      }

      // Si no existe, generar valor
      this.logger.debug("❌ Cache MISS", { key });
      const value = await fetcher();

      // Guardar en cache
      await this.set(key, value, type);

      return value;
    } catch (error) {
      this.logger.error("❌ Error en getOrSet", error, { key });
      throw error;
    }
  }

  async clearQr(sessionId) {
  const key = this.keys.qr(sessionId);
  try {
    await this.redis.del(key);
    return true;
  } catch (err) {
    this.logger.error("❌ Error limpiando QR", err, { sessionId });
    return false;
  }
}


  /**
   * 🗑️ Invalida cache por patrón
   */
  async invalidate(pattern) {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.info("🗑️ Cache invalidado", {
          pattern,
          keysRemoved: keys.length,
        });
      }
      return keys.length;
    } catch (error) {
      this.logger.error("❌ Error invalidando cache", error, { pattern });
      return 0;
    }
  }

  /**
   * 🧹 Invalida toda la cache de una sesión
   */
  async invalidateSession(sessionId) {
    return await this.invalidate(`session:${sessionId}:*`);
  }

  /**
   * 💾 Guarda QR en cache
   */
  async setQr(sessionId, qr) {
    const key = this.keys.qr(sessionId);
    return await this.set(key, { qr, timestamp: Date.now() }, "qr");
  }

  /**
   * 📖 Obtiene QR del cache
   */
  async getQr(sessionId) {
    const key = this.keys.qr(sessionId);
    const cached = await this.get(key);
    return cached?.qr || null;
  }

  /**
   * 🔀 Verifica si QR cambió (de-duplicación)
   */
  async isNewQr(sessionId, newQr) {
    const cachedQr = await this.getQr(sessionId);
    return newQr !== cachedQr;
  }

  /**
   * 📊 Guarda estado de sesión en cache
   */
  async setStatus(sessionId, status) {
    const key = this.keys.status(sessionId);
    return await this.set(key, { status, timestamp: Date.now() }, "status");
  }

  /**
   * 📖 Obtiene estado del cache
   */
  async getStatus(sessionId) {
    const key = this.keys.status(sessionId);
    const cached = await this.get(key);
    return cached?.status || null;
  }

  /**
   * 📡 Guarda estado de conexión en cache
   */
  async setConnection(sessionId, connection) {
    const key = this.keys.connection(sessionId);
    return await this.set(
      key,
      { connection, timestamp: Date.now() },
      "connection"
    );
  }

  /**
   * 📡 Obtiene estado de conexión del cache
   */
  async getConnection(sessionId) {
    const key = this.keys.connection(sessionId);
    const cached = await this.get(key);
    return cached?.connection || null;
  }

  /**
   * ℹ️ Guarda info de sesión en cache
   */
  async setSessionInfo(sessionId, info) {
    const key = this.keys.session(sessionId);
    return await this.set(key, { ...info, timestamp: Date.now() }, "session");
  }

  /**
   * ℹ️ Obtiene info de sesión del cache
   */
  async getSessionInfo(sessionId) {
    const key = this.keys.session(sessionId);
    const cached = await this.get(key);
    return cached || null;
  }

  /**
   * 📊 Obtiene métricas del cache
   */
  async getMetrics() {
    try {
      const info = await this.redis.info("stats");
      const keys = await this.redis.keys("session:*");

      return {
        totalKeys: keys.length,
        qrKeys: keys.filter((k) => k.includes(":qr")).length,
        statusKeys: keys.filter((k) => k.includes(":status")).length,
        connectionKeys: keys.filter((k) => k.includes(":connection")).length,
        sessionKeys: keys.filter((k) => k.includes(":info")).length,
      };
    } catch (error) {
      this.logger.error("❌ Error obteniendo métricas", error);
      return null;
    }
  }
}

module.exports = CacheManager;
