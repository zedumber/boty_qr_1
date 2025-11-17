/**
 * 📱 WhatsApp Manager - Arquitectura Modular
 *
 * Exporta: SessionManager, ConnectionManager, QRManager, EventManager
 * Proporciona: WhatsAppManager como fachada unificada
 *
 * Beneficios de la arquitectura modular:
 * ✅ Escalabilidad: Cada componente es independiente
 * ✅ Mantenibilidad: Código más limpio y organizado
 * ✅ Testabilidad: Cada módulo puede ser testeado por separado
 * ✅ Flexibilidad: Fácil reemplazar componentes
 * ✅ Rendimiento: Separación de responsabilidades
 */

const SessionManager = require("./sessionManager");
const ConnectionManager = require("./connectionManager");
const QRManager = require("./qrManager");
const EventManager = require("./eventManager");

class WhatsAppManager {
  constructor(axios, laravelApi, logger, queueManager, config = {}) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.queueManager = queueManager;

    // Configuración consolidada
    this.config = {
      authDir: config.authDir,
      maxRetries: config.maxRetries || 3,
      backoffBase: config.backoffBase || 600,
      backoffJitter: config.backoffJitter || 400,
      qrThrottleMs: config.qrThrottleMs || 30000,
      qrExpiresMs: config.qrExpiresMs || 60000,
      maxQrRetries: config.maxQrRetries || 10,
    };

    // Inicializar managers
    this.sessionManager = new SessionManager(axios, laravelApi, logger, {
      authDir: this.config.authDir,
      maxRetries: this.config.maxRetries,
      backoffBase: this.config.backoffBase,
      backoffJitter: this.config.backoffJitter,
    });

    this.qrManager = new QRManager(axios, laravelApi, logger, {
      qrThrottleMs: this.config.qrThrottleMs,
      qrExpiresMs: this.config.qrExpiresMs,
      maxQrRetries: this.config.maxQrRetries,
      backoffBase: this.config.backoffBase,
      backoffJitter: this.config.backoffJitter,
    });

    this.connectionManager = new ConnectionManager(axios, laravelApi, logger, {
      maxRetries: this.config.maxRetries,
      backoffBase: this.config.backoffBase,
      backoffJitter: this.config.backoffJitter,
    });

    this.eventManager = new EventManager(
      this.connectionManager,
      this.qrManager,
      this.sessionManager,
      queueManager,
      logger
    );

    // Delegación de métodos
    this.sessions = this.sessionManager.sessions;
  }

  /**
   * 🚀 Inicia una sesión de WhatsApp
   */
  async startSession(sessionId, userId) {
    return await this.sessionManager.startSession(
      sessionId,
      userId,
      this.eventManager
    );
  }

  /**
   * 🗑️ Elimina una sesión
   */
  async deleteSession(sessionId) {
    return await this.sessionManager.deleteSession(sessionId);
  }

  /**
   * 📊 Obtiene información de una sesión
   */
  getSessionInfo(sessionId) {
    return this.sessionManager.getSessionInfo(sessionId);
  }

  /**
   * 📋 Lista todas las sesiones activas
   */
  listActiveSessions() {
    return this.sessionManager.listActiveSessions();
  }

  /**
   * 🔄 Restaura todas las sesiones desde Laravel
   */
  async restoreSessions() {
    return await this.sessionManager.restoreSessions(this.eventManager);
  }

  /**
   * 🛑 Cierra todas las sesiones
   */
  async closeAllSessions() {
    return await this.sessionManager.closeAllSessions();
  }

  /**
   * 📊 Obtiene estadísticas globales del sistema
   */
  getStats() {
    return {
      sessions: this.sessionManager.getSessionStats(),
      qr: this.qrManager.getQRStats(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 🔌 Registra callback para evento de sesión abierta
   */
  onSessionOpen(callback) {
    this.connectionManager.onSessionOpen(callback);
  }

  /**
   * 🔌 Registra callback para evento de sesión cerrada
   */
  onSessionClose(callback) {
    this.connectionManager.onSessionClose(callback);
  }
}

module.exports = WhatsAppManager;
