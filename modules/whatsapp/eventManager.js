/**
 * 📡 Event Manager
 * Gestiona los eventos de Baileys de manera centralizada
 * Responsabilidades:
 * - Registrar listeners de eventos para sesiones
 * - Coordinar entre managers
 * - Manejar eventos de mensajes
 * - Manejar eventos de credenciales
 * - Desacoplar la lógica de eventos de los managers
 */

class EventManager {
  constructor(
    connectionManager,
    qrManager,
    sessionManager,
    queueManager,
    logger
  ) {
    this.connectionManager = connectionManager;
    this.qrManager = qrManager;
    this.sessionManager = sessionManager;
    this.queueManager = queueManager;
    this.logger = logger;
  }

  /**
   * 📡 Registra todos los listeners de eventos para una sesión
   */
  registerSessionEvents(sessionId, socket, userId) {
    this.logger.info("📡 Registrando eventos para sesión", { sessionId });

    // 📡 Event: Actualización de conexión
    socket.ev.on("connection.update", async (update) => {
      try {
        await this._handleConnectionUpdate(update, sessionId, userId);
      } catch (error) {
        this.logger.error("❌ Error en connection.update", error, {
          sessionId,
        });
      }
    });

    // 📩 Event: Mensajes entrantes
    socket.ev.on("messages.upsert", async (msgUpdate) => {
      try {
        await this._handleMessagesUpsert(msgUpdate, sessionId);
      } catch (error) {
        this.logger.error("❌ Error en messages.upsert", error, {
          messageId: msgUpdate.messages[0]?.key?.id,
          sessionId,
        });
      }
    });

    // 🔄 Event: Actualización de credenciales
    socket.ev.on("creds.update", async (creds) => {
      try {
        this.logger.debug("🔄 Credenciales actualizadas", { sessionId });
        // Las credenciales se guardan automáticamente con saveCreds
      } catch (error) {
        this.logger.error("❌ Error en creds.update", error, { sessionId });
      }
    });

    this.logger.info("✅ Eventos registrados correctamente", { sessionId });
  }

  /**
   * 📡 Maneja actualización de conexión
   */
  async _handleConnectionUpdate(update, sessionId, userId) {
    const { connection, qr } = update;

    this.logger.info("📡 Actualización de conexión", {
      connection,
      sessionId,
    });

    // Obtener QR si existe
    const qrCode = await this.connectionManager.handleConnectionUpdate(
      update,
      sessionId,
      userId,
      this.sessionManager
    );

    // Manejar QR
    if (qrCode) {
      await this.qrManager.handleQrCode(qrCode, sessionId, connection);
    }
  }

  /**
   * 📩 Maneja mensajes entrantes
   */
  async _handleMessagesUpsert(msgUpdate, sessionId) {
    this.logger.info("📩 Mensaje recibido", { sessionId });

    // Actualizar actividad de sesión
    this.sessionManager.updateLastActivity(sessionId);

    try {
      // Agregar a la cola de procesamiento
      await this.queueManager.addMessageToQueue(msgUpdate, sessionId);
    } catch (error) {
      this.logger.error("❌ Error agregando mensaje a cola", error, {
        messageId: msgUpdate.messages[0]?.key?.id,
        sessionId,
      });
      throw error;
    }
  }

  /**
   * ⚡ Desregistra eventos de una sesión (para limpiar)
   */
  unregisterSessionEvents(sessionId, socket) {
    try {
      this.logger.info("🧹 Desregistrando eventos de sesión", { sessionId });
      socket.ev.removeAllListeners();
    } catch (error) {
      this.logger.error("❌ Error desregistrando eventos", error, {
        sessionId,
      });
    }
  }
}

module.exports = EventManager;
