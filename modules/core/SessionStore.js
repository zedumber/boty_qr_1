const fs = require("fs");
const path = require("path");
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");

/**
 * 📦 SessionStore mejorado para 200+ usuarios
 * - Gestiona sesiones con TTL (Time To Live)
 * - Limita sesiones activas máximas
 * - Monitorea memoria e inactividad
 */
class SessionStore {
  constructor(logger, maxSessions = 250, idleTTL = 86400000) {
    this.logger = logger;
    this.sessions = {};
    this.sessionMetadata = new Map(); // { sessionId -> { createdAt, lastActivity } }
    this.authDir = path.join(__dirname, "..", "..", "auth");

    this.maxSessions = maxSessions || 250; // 250 sesiones máximo
    this.idleTTL = idleTTL || 86400000; // 24 horas de inactividad

    // Iniciar limpieza periódica
    this.startCleanupInterval();
  }

  getSocket(sessionId) {
    return this.sessions[sessionId] || null;
  }

  has(sessionId) {
    return !!this.sessions[sessionId];
  }

  save(sessionId, sock) {
    // Validar límite de sesiones
    const activeSessions = Object.keys(this.sessions).length;
    if (activeSessions >= this.maxSessions && !this.sessions[sessionId]) {
      this.logger.warn("⚠️ Límite de sesiones alcanzado", {
        current: activeSessions,
        max: this.maxSessions,
      });
      throw new Error(`Max sessions (${this.maxSessions}) reached`);
    }

    this.sessions[sessionId] = sock;

    // Registrar metadata
    if (!this.sessionMetadata.has(sessionId)) {
      this.sessionMetadata.set(sessionId, {
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });
    } else {
      const meta = this.sessionMetadata.get(sessionId);
      meta.lastActivity = Date.now();
    }
  }

  delete(sessionId) {
    if (this.sessions[sessionId]) {
      try {
        this.sessions[sessionId].end();
      } catch (_) {}
      delete this.sessions[sessionId];
    }

    this.sessionMetadata.delete(sessionId);

    const dir = path.join(this.authDir, sessionId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    this.logger.info("🗑️ Sesión eliminada", { sessionId });
  }

  async loadAuth(sessionId) {
    const dir = path.join(this.authDir, sessionId);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    return await useMultiFileAuthState(dir);
  }

  /**
   * 🧹 Limpia sesiones inactivas por más de idleTTL
   */
  cleanInactiveSessions() {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, meta] of this.sessionMetadata) {
      const inactiveDuration = now - meta.lastActivity;

      if (inactiveDuration > this.idleTTL) {
        this.logger.info("🧹 Eliminando sesión inactiva", {
          sessionId,
          inactiveDays: Math.round(inactiveDuration / 86400000),
        });

        this.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.info("🧹 Sesiones inactivas limpiadas", {
        count: cleaned,
        remaining: Object.keys(this.sessions).length,
      });
    }

    return cleaned;
  }

  /**
   * 📊 Obtiene estadísticas de sesiones
   */
  getStats() {
    return {
      activeSessions: Object.keys(this.sessions).length,
      maxSessions: this.maxSessions,
      memoryUsage:
        Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + " MB",
    };
  }

  /**
   * ⏲️ Inicia limpieza periódica
   */
  startCleanupInterval() {
    this.cleanupInterval = setInterval(() => {
      this.cleanInactiveSessions();
    }, 60 * 60 * 1000); // cada hora
  }

  stopCleanupInterval() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

module.exports = SessionStore;
