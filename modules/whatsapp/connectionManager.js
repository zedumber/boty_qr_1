/**
 * 🔌 Connection Manager
 * Gestiona eventos de conexión y desconexión
 * Responsabilidades:
 * - Manejar cambios de estado de conexión
 * - Lógica de reconexión con reintentos
 * - Notificar a Laravel sobre cambios de estado
 * - Coordinar con otros managers
 */

const { DisconnectReason } = require("@whiskeysockets/baileys");
const { sleep, postLaravel } = require("./utils");

class ConnectionManager {
  constructor(axios, laravelApi, logger, config = {}) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;

    this.maxRetries = config.maxRetries || 3;
    this.backoffBase = config.backoffBase || 600;
    this.backoffJitter = config.backoffJitter || 400;

    // Callbacks para coordinación
    this.callbacks = {
      onSessionOpen: null,
      onSessionClose: null,
    };
  }

  /**
   * 📋 Registra callbacks para eventos
   */
  onSessionOpen(callback) {
    this.callbacks.onSessionOpen = callback;
  }

  onSessionClose(callback) {
    this.callbacks.onSessionClose = callback;
  }

  /**
   * 🌐 Envía datos a Laravel con reintentos
   */
  async postLaravel(path, body, attempts = this.maxRetries) {
    return postLaravel(this.axios, this.laravelApi, this.logger, path, body, {
      attempts,
      backoffBase: this.backoffBase,
      backoffJitter: this.backoffJitter,
    });
  }

  /**
   * ✅ Maneja la sesión abierta
   * NOTA: Cuando Baileys emite 'connection: open', significa que la sesión
   * está lista. El estado DEBE pasar a "active" aquí.
   */
  async handleSessionOpen(sessionId, sessionManager) {
    this.logger.info("✅ Sesión abierta (connection='open')", { sessionId });

    // Ejecutar callback si existe
    if (this.callbacks.onSessionOpen) {
      try {
        await this.callbacks.onSessionOpen(sessionId);
      } catch (err) {
        this.logger.error("❌ Error en callback de sesión abierta", err, {
          sessionId,
        });
      }
    }

    // Verificar que la sesión sigue activa en Laravel
    const active = await sessionManager.isSessionActiveInLaravel(sessionId);
    if (!active) {
      this.logger.warn("⚠️ Sesión no activa en Laravel al abrir", {
        sessionId,
      });
      return;
    }

    try {
      // Cambiar estado a "active" - significa que Baileys confirmó la conexión
      await this.postLaravel("/whatsapp/status", {
        session_id: sessionId,
        estado_qr: "active",
      });

      this.logger.info("✅ Estado actualizado a active", { sessionId });
    } catch (err) {
      this.logger.error("❌ Error actualizando estado a active", err, {
        sessionId,
      });
    }
  }

  /**
   * 🔌 Maneja el cierre de sesión
   */
  async handleSessionClose(sessionId, userId, lastDisconnect, sessionManager) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    this.logger.info("🔌 Sesión cerrada", { sessionId, statusCode, loggedOut });

    // Ejecutar callback si existe
    if (this.callbacks.onSessionClose) {
      try {
        await this.callbacks.onSessionClose(sessionId, loggedOut);
      } catch (err) {
        this.logger.error("❌ Error en callback de sesión cerrada", err, {
          sessionId,
        });
      }
    }

    if (loggedOut) {
      // Usuario desconectado explícitamente → marcar inactive
      try {
        await this.postLaravel("/whatsapp/status", {
          session_id: sessionId,
          estado_qr: "inactive",
        });
        this.logger.info("✅ Estado actualizado a inactive", { sessionId });
      } catch (err) {
        this.logger.error("❌ Error actualizando estado a inactive", err, {
          sessionId,
        });
      }

      // Limpiar de memoria
      delete sessionManager.sessions[sessionId];
    } else {
      // Reintentar solo si la sesión sigue activa en Laravel
      const active = await sessionManager.isSessionActiveInLaravel(sessionId);

      if (active) {
        this.logger.info("🔄 Reintentando conexión", { sessionId });
        await sessionManager.startSession(sessionId, userId);
      } else {
        this.logger.warn("⚠️ SessionId inactivo, no se reintenta conexión", {
          sessionId,
        });
      }
    }
  }

  /**
   * 🔄 Maneja actualización de conexión
   */
  async handleConnectionUpdate(update, sessionId, userId, sessionManager) {
    const { connection, lastDisconnect, qr } = update;

    this.logger.info("📡 Actualización de conexión", {
      connection,
      sessionId,
    });

    // Sesión abierta
    if (connection === "open") {
      await this.handleSessionOpen(sessionId, sessionManager);
    }

    // Sesión cerrada
    if (connection === "close") {
      await this.handleSessionClose(
        sessionId,
        userId,
        lastDisconnect,
        sessionManager
      );
    }

    return qr;
  }
}

module.exports = ConnectionManager;
