// src/services/whatsapp/connection.manager.js

/**
 * 🔌 Gestor de Conexión y Reconexión
 *
 * Responsabilidad:
 * - Manejar eventos de conexión/desconexión
 * - Implementar lógica de reconexión con backoff exponencial
 * - Validar estados antes de reconectar
 */

const { DisconnectReason } = require("@whiskeysockets/baileys");
const { sleep } = require("../../utils/helpers");

class ConnectionManager {
  constructor(
    stateManager,
    qrManager,
    sessionManager,
    axios,
    laravelApi,
    logger
  ) {
    this.stateManager = stateManager;
    this.qrManager = qrManager;
    this.sessionManager = sessionManager;
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;

    // Tokens de webhook por sesión
    this.tokens = {}; // sessionId → webhook_token
  }

  /**
   * ✅ Maneja sesión abierta exitosamente
   */
  async handleSessionOpen(sessionId) {
    this.logger.info("✅ Sesión abierta", { sessionId });

    this.qrManager.clearQrState(sessionId);

    await this.stateManager.updateSessionStatus(sessionId, "active", "high");

    // Reset contador de reconexiones
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      session.reconnectAttempts = 0;
      session.reconnecting = false;
    }
  }

  /**
   * 🔌 Maneja cierre de sesión
   */
  async handleSessionClose(sessionId, userId, lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    this.logger.info("🔌 Sesión cerrada", { sessionId, statusCode, loggedOut });

    // Siempre limpiar estado QR y cache
    this.qrManager.clearQrState(sessionId);
    this.stateManager.clearSessionCache(sessionId);

    // ❌ Casos donde NO se debe reconectar
    const noReconnectCodes = [
      DisconnectReason.loggedOut, // 401
      405, // Credenciales corruptas
      428, // Connection closed
    ];

    if (noReconnectCodes.includes(statusCode)) {
      this.logger.warn(`⛔ Sesión cerrada con ${statusCode}, NO reconectando`, {
        sessionId,
      });
      await this.stateManager.updateSessionStatus(
        sessionId,
        "inactive",
        "high"
      );
      this.sessionManager.removeSession(sessionId);
      return;
    }

    // Verificar si ya hay reconexión en progreso
    const session = this.sessionManager.getSession(sessionId);
    if (session?.reconnecting) {
      this.logger.warn("⏳ Reconexión ya en progreso, ignorando...", {
        sessionId,
      });
      return;
    }

    // Iniciar proceso de reconexión
    await this.attemptReconnection(sessionId, userId, lastDisconnect);
  }

  /**
   * 🔄 Intenta reconectar con backoff exponencial
   */
  async attemptReconnection(sessionId, userId, lastDisconnect) {
    // Marcar estado como "connecting"
    await this.stateManager.updateSessionStatus(
      sessionId,
      "connecting",
      "normal"
    );

    // Obtener o inicializar sesión
    let session = this.sessionManager.getSession(sessionId);
    if (!session) {
      session = this.sessionManager.initializeSession(sessionId);
    }

    session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
    session.reconnecting = true;

    const attempt = session.reconnectAttempts;
    const maxAttempts = 5;

    if (attempt > maxAttempts) {
      this.logger.error("❌ Máximo de reintentos alcanzado", {
        sessionId,
        attempt,
      });
      await this.stateManager.updateSessionStatus(
        sessionId,
        "inactive",
        "high"
      );
      this.sessionManager.removeSession(sessionId);
      return;
    }

    // Backoff exponencial: 2s, 4s, 8s, 16s, 32s
    const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 32000);

    this.logger.info("🔄 Programando reconexión", {
      sessionId,
      attempt,
      maxAttempts,
      backoffMs,
    });

    setTimeout(async () => {
      try {
        // Verificar que la sesión sigue siendo válida para reconectar
        const isValid = await this.isSessionActive(sessionId, {
          forReconnect: true,
        });

        if (!isValid) {
          this.logger.warn("⚠️ Sesión ya no es válida para reconectar", {
            sessionId,
          });
          this.sessionManager.removeSession(sessionId);
          return;
        }

        // Cerrar socket anterior si existe
        const currentSession = this.sessionManager.getSession(sessionId);
        if (currentSession?.sock) {
          try {
            currentSession.sock.end();
          } catch (_) {
            // Ignorar errores al cerrar
          }
        }

        this.logger.info("🔄 Ejecutando reconexión", { sessionId, attempt });

        const webhookToken = this.tokens[sessionId];
        await this.sessionManager.startSession(sessionId, userId, webhookToken);

        // Reset contador en éxito
        const reconnectedSession = this.sessionManager.getSession(sessionId);
        if (reconnectedSession) {
          reconnectedSession.reconnectAttempts = 0;
          reconnectedSession.reconnecting = false;
        }
      } catch (err) {
        this.logger.error("❌ Error en reconexión", err, {
          sessionId,
          attempt,
        });

        // Programar otro intento si no se alcanzó el máximo
        const retrySession = this.sessionManager.getSession(sessionId);
        if (retrySession && attempt < maxAttempts) {
          retrySession.reconnecting = false;
          await this.handleSessionClose(sessionId, userId, lastDisconnect);
        } else {
          await this.stateManager.updateSessionStatus(
            sessionId,
            "inactive",
            "high"
          );
          this.sessionManager.removeSession(sessionId);
        }
      }
    }, backoffMs);
  }

  /**
   * ✅ Verifica si una sesión está activa
   */
  async isSessionActive(sessionId, options = {}) {
    try {
      const webhookToken =
        this.tokens[sessionId] || (await this.fetchWebhookToken(sessionId));

      if (!webhookToken) {
        this.logger.warn("⚠️ No se pudo obtener webhook_token", { sessionId });
        return false;
      }

      // 1️⃣ Cache local (invalidar si es para reconexión)
      const cachedActive = this.stateManager.getFromLocalCache(
        sessionId,
        options.forReconnect
      );
      if (cachedActive !== null) {
        return cachedActive;
      }

      // 2️⃣ Redis: "active" o "connecting" son válidos para reconexión
      const redisStatus = await this.stateManager.getStatusFromRedis(sessionId);
      if (redisStatus) {
        const isActive = options.forReconnect
          ? redisStatus === "active" || redisStatus === "connecting"
          : redisStatus === "active";

        this.stateManager.sessionActiveCache.set(sessionId, {
          active: isActive,
          timestamp: Date.now(),
        });

        return isActive;
      }

      // 3️⃣ Laravel
      const estado = await this.getQrStatus(webhookToken, sessionId);

      const isActive = options.forReconnect
        ? estado === "active" || estado === "connecting"
        : estado === "active";

      this.stateManager.sessionActiveCache.set(sessionId, {
        active: isActive,
        timestamp: Date.now(),
      });

      return isActive;
    } catch (err) {
      this.logger.error("❌ Error verificando sessionId en Laravel", err, {
        sessionId,
      });
      return false;
    }
  }

  /**
   * 🔍 Obtiene estado de QR en Laravel
   */
  async getQrStatus(webhookToken, sessionId) {
    if (!webhookToken && sessionId) {
      webhookToken = await this.fetchWebhookToken(sessionId);
    }

    if (!webhookToken) {
      this.logger.warn("⚠️ No existe webhook_token para la sesión", {
        sessionId,
      });
      return null;
    }

    try {
      const { data } = await this.axios.get(
        `${this.laravelApi}/whatsapp/status/token/${webhookToken}`
      );
      return data?.estado_qr ?? null;
    } catch (error) {
      this.logger.error("❌ Error obteniendo estado QR por token", error, {
        webhookToken,
        sessionId,
      });
      return null;
    }
  }

  /**
   * 🔑 Obtiene webhook_token desde Laravel
   */
  async fetchWebhookToken(sessionId) {
    if (!sessionId) return null;

    try {
      const { data } = await this.axios.get(
        `${this.laravelApi}/whatsapp/account/${sessionId}`
      );

      if (data?.webhook_token) {
        this.tokens[sessionId] = data.webhook_token;
        return data.webhook_token;
      }

      this.logger.warn("⚠️ Cuenta sin webhook_token en Laravel", { sessionId });
      return null;
    } catch (error) {
      this.logger.error(
        "❌ Error obteniendo webhook_token desde Laravel",
        error,
        { sessionId }
      );
      return null;
    }
  }

  /**
   * 🔑 Registra webhook_token
   */
  setWebhookToken(sessionId, webhookToken) {
    if (webhookToken) {
      this.tokens[sessionId] = webhookToken;
    }
  }
}

module.exports = ConnectionManager;
