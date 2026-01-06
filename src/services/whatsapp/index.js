// src/services/whatsapp/index.js

/**
 * 🎯 WhatsApp Service Facade
 *
 * Punto de entrada único que orquesta todos los managers.
 * Expone la misma API que el servicio monolítico original.
 */

const path = require("path");
const SocketFactory = require("./socket.factory");
const StateManager = require("./state.manager");
const QRManager = require("./qr.manager");
const ConnectionManager = require("./connection.manager");
const SessionManager = require("./session.manager");

class WhatsAppService {
  /**
   * @param {import("axios").AxiosInstance} axios
   * @param {string} laravelApi
   * @param {object} logger
   * @param {QueueManager} queueManager
   * @param {CacheManager} cacheManager
   * @param {BatchQueueManager} batchQueueManager
   */
  constructor(
    axios,
    laravelApi,
    logger,
    queueManager,
    cacheManager,
    batchQueueManager,
    config = {}
  ) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.queueManager = queueManager;
    this.cacheManager = cacheManager;
    this.batchQueueManager = batchQueueManager;
    this.config = config;

    const authDir = path.join(__dirname, "..", "..", "auth");

    // 🏗️ Inicializar managers
    this.socketFactory = new SocketFactory(authDir, logger);

    this.stateManager = new StateManager(
      cacheManager,
      batchQueueManager,
      logger,
      config
    );

    this.qrManager = new QRManager(
      cacheManager,
      batchQueueManager,
      this.stateManager,
      logger
    );

    this.connectionManager = new ConnectionManager(
      this.stateManager,
      this.qrManager,
      null, // sessionManager se asigna después
      axios,
      laravelApi,
      logger,
      config
    );

    this.sessionManager = new SessionManager(
      this.socketFactory,
      this.connectionManager,
      this.qrManager,
      queueManager,
      axios,
      laravelApi,
      logger,
      this.stateManager,
      config
    );

    // Resolver dependencia circular
    this.connectionManager.sessionManager = this.sessionManager;

    // Exponer sessions para compatibilidad con controllers
    this.sessions = this.sessionManager.sessions;
  }

  // ==========================================
  // 📡 API Pública - Métodos de Sesión
  // ==========================================

  /**
   * 🚀 Inicia una sesión de WhatsApp
   */
  async startSession(sessionId, userId, webhookToken) {
    return await this.sessionManager.startSession(
      sessionId,
      userId,
      webhookToken
    );
  }

  /**
   * 🔄 Restaura sesiones activas desde Laravel
   */
  async restoreSessions() {
    return await this.sessionManager.restoreSessions();
  }

  /**
   * 🗑️ Elimina una sesión
   */
  async deleteSession(sessionId, preserveAuth = false) {
    return await this.sessionManager.deleteSession(sessionId, preserveAuth);
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
   * 🛑 Cierra todas las sesiones
   */
  async closeAllSessions(preserveAuth = false) {
    return await this.sessionManager.closeAllSessions(preserveAuth);
  }

  /**
   * 🧹 Limpia sesiones muertas
   */
  async cleanupDeadSessions() {
    return await this.sessionManager.cleanupDeadSessions();
  }

  /**
   * ⏱️ Ejecuta watchdog manual
   */
  async runSessionWatchdog() {
    return await this.sessionManager.runWatchdog();
  }

  // ==========================================
  // 🔍 API Pública - Validación y Estado
  // ==========================================

  /**
   * ✅ Verifica si una sesión está activa
   */
  async isSessionActive(sessionId, options = {}) {
    return await this.connectionManager.isSessionActive(sessionId, options);
  }

  /**
   * 🔍 Obtiene estado de QR en Laravel
   */
  async getQrStatus(webhookToken, sessionId) {
    return await this.connectionManager.getQrStatus(webhookToken, sessionId);
  }

  /**
   * 🔑 Obtiene webhook_token desde Laravel
   */
  async fetchWebhookToken(sessionId) {
    return await this.connectionManager.fetchWebhookToken(sessionId);
  }

  // ==========================================
  // 🧰 API Pública - Helpers
  // ==========================================

  /**
   * 🧰 Helper para POST a Laravel con reintentos
   */
  async postLaravel(pathUrl, body, attempts) {
    return await this.sessionManager.postLaravel(pathUrl, body, attempts);
  }

  // ==========================================
  // 🔧 Getters para acceso a managers (debug)
  // ==========================================

  get tokens() {
    return this.connectionManager.tokens;
  }

  set tokens(value) {
    this.connectionManager.tokens = value;
  }
}

module.exports = WhatsAppService;
