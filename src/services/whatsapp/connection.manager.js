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
    logger,
    config = {}
  ) {
    this.stateManager = stateManager;
    this.qrManager = qrManager;
    this.sessionManager = sessionManager;
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.config = config;

    // Tokens de webhook por sesión
    this.tokens = {}; // sessionId → webhook_token

    const reconnection = config?.reconnection || {};
    this.reconnectConfig = {
      fastAttempts: reconnection.fastAttempts ?? 5,
      fastBackoffBaseMs: reconnection.fastBackoffBaseMs ?? 2000,
      fastBackoffMaxMs: reconnection.fastBackoffMaxMs ?? 32000,
      resilienceDelaysMs: reconnection.resilienceDelaysMs || [
        60000, 300000, 900000,
      ],
      maxDurationMs: reconnection.maxDurationMs ?? 60 * 60 * 1000,
    };
  }

  /**
   * ✅ Maneja sesión abierta exitosamente
   */
  async handleSessionOpen(sessionId) {
    this.logger.info("✅ Sesión abierta", { sessionId });

    this.qrManager.clearQrState(sessionId);

    await this.stateManager.updateSessionStatus(sessionId, "active", "high");
    await this.stateManager.recordTransition(sessionId, "session_open", {});

    // Reset contador de reconexiones
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      session.reconnectAttempts = 0;
      session.reconnecting = false;
      session.reconnectTask = null;
    }
  }

  /**
   * 🔌 Maneja cierre de sesión
   */
  async handleSessionClose(sessionId, userId, lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    this.logger.info("🔌 Sesión cerrada", { sessionId, statusCode, loggedOut });
    await this.stateManager.recordTransition(sessionId, "session_close", {
      statusCode,
      loggedOut,
    });

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
      await this.stateManager.recordTransition(
        sessionId,
        "session_closed_no_reconnect",
        { statusCode }
      );
      this.sessionManager.removeSession(sessionId);
      return;
    }

    // Verificar si ya hay reconexión en progreso
    const session = this.sessionManager.getSession(sessionId);
    if (session?.reconnecting || session?.reconnectTask) {
      this.logger.warn("⏳ Reconexión ya en progreso, ignorando...", {
        sessionId,
      });
      return;
    }

    // Iniciar proceso de reconexión
    this.attemptReconnection(sessionId, userId, lastDisconnect, {
      reason: "disconnect",
      statusCode,
    });
  }

  /**
   * 🔄 Intenta reconectar con modo resiliencia
   */
  attemptReconnection(sessionId, userId, lastDisconnect, context = {}) {
    this.startReconnectWorker(sessionId, userId, {
      ...context,
      lastDisconnect,
    });
  }

  requestReconnect(sessionId, userId, context = {}) {
    this.startReconnectWorker(sessionId, userId, context);
  }

  startReconnectWorker(sessionId, userId, context = {}) {
    let session = this.sessionManager.getSession(sessionId);
    if (!session) {
      session = this.sessionManager.initializeSession(sessionId);
    }

    if (session.reconnecting || session.reconnectTask) {
      this.logger.warn("⏳ Reconexión ya agendada", { sessionId });
      return;
    }

    session.reconnectAttempts = session.reconnectAttempts || 0;
    session.reconnecting = true;

    const worker = this.runReconnectLoop(sessionId, userId, context);
    session.reconnectTask = worker;

    worker
      .catch((err) => {
        this.logger.error("❌ Error en reconexión", err, { sessionId });
      })
      .finally(() => {
        const current = this.sessionManager.getSession(sessionId);
        if (current) {
          current.reconnectTask = null;
          current.reconnecting = false;
        }
      });
  }

  async runReconnectLoop(sessionId, userId, context = {}) {
    await this.stateManager.updateSessionStatus(
      sessionId,
      "connecting",
      "normal"
    );
    await this.stateManager.recordTransition(sessionId, "reconnect_started", {
      reason: context.reason,
    });

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return;
    }

    const startedAt = Date.now();
    let resilienceStartedAt = null;

    while (session.reconnecting) {
      const aborting = await this.abortReconnectIfActive(sessionId);
      if (aborting) {
        await this.stateManager.recordTransition(
          sessionId,
          "reconnect_aborted_active",
          {
            status: aborting.status,
          }
        );
        return;
      }

      session.reconnectAttempts += 1;
      const attempt = session.reconnectAttempts;
      const mode =
        attempt <= this.reconnectConfig.fastAttempts ? "fast" : "resilience";

      if (mode === "resilience" && !resilienceStartedAt) {
        resilienceStartedAt = Date.now();
        await this.stateManager.recordTransition(
          sessionId,
          "reconnect_resilience_mode",
          { attempt, reason: context.reason }
        );
      }

      await this.stateManager.recordTransition(sessionId, "reconnect_attempt", {
        attempt,
        mode,
        reason: context.reason,
      });

      const success = await this.executeReconnectAttempt(sessionId, userId);

      if (success) {
        await this.stateManager.recordTransition(
          sessionId,
          "reconnect_success",
          {
            attempt,
            durationMs: Date.now() - startedAt,
          }
        );
        return;
      }

      const delay = this.getReconnectDelay(attempt);
      if (!delay) {
        break;
      }

      await this.stateManager.recordTransition(sessionId, "reconnect_backoff", {
        attempt,
        delay,
        mode,
      });

      await sleep(delay);

      if (
        mode === "resilience" &&
        resilienceStartedAt &&
        Date.now() - resilienceStartedAt >= this.reconnectConfig.maxDurationMs
      ) {
        await this.stateManager.recordTransition(
          sessionId,
          "reconnect_resilience_timeout",
          {
            durationMs: Date.now() - resilienceStartedAt,
          }
        );
        break;
      }
    }

    await this.stateManager.recordTransition(sessionId, "reconnect_exhausted", {
      attempts: session?.reconnectAttempts || 0,
    });
    await this.stateManager.updateSessionStatus(sessionId, "inactive", "high");
    this.sessionManager.removeSession(sessionId);
  }

  async abortReconnectIfActive(sessionId) {
    const status = await this.isSessionActive(sessionId, {
      forReconnect: true,
      returnDetailed: true,
      acceptedStatuses: ["active"],
    });

    if (status.active) {
      this.logger.info("🔁 Reintento cancelado: sesión ya activa", {
        sessionId,
        status: status.status,
      });
      return status;
    }

    return null;
  }

  async executeReconnectAttempt(sessionId, userId) {
    try {
      const currentSession = this.sessionManager.getSession(sessionId);
      if (currentSession?.sock) {
        try {
          currentSession.sock.end();
        } catch (err) {
          this.logger.debug("⚠️ Error cerrando socket previo", {
            sessionId,
            error: err?.message,
          });
        }
      }

      const webhookToken =
        this.tokens[sessionId] || (await this.fetchWebhookToken(sessionId));
      await this.sessionManager.startSession(sessionId, userId, webhookToken);
      return true;
    } catch (error) {
      this.logger.error("❌ Error en intento de reconexión", error, {
        sessionId,
      });
      return false;
    }
  }

  getReconnectDelay(attempt) {
    if (attempt <= this.reconnectConfig.fastAttempts) {
      const exponent = attempt - 1;
      const delay =
        this.reconnectConfig.fastBackoffBaseMs * Math.pow(2, exponent);
      return Math.min(delay, this.reconnectConfig.fastBackoffMaxMs);
    }

    const schedule = this.reconnectConfig.resilienceDelaysMs;
    if (!schedule || schedule.length === 0) {
      return null;
    }

    const index = attempt - this.reconnectConfig.fastAttempts - 1;
    return schedule[index % schedule.length];
  }

  /**
   * ✅ Verifica si una sesión está activa
   */
  async isSessionActive(sessionId, options = {}) {
    const {
      forReconnect = false,
      returnDetailed = false,
      acceptedStatuses,
      skipCache = false,
    } = options;

    const accepted = new Set(
      acceptedStatuses?.length
        ? acceptedStatuses
        : forReconnect
        ? ["active", "connecting"]
        : ["active"]
    );

    const response = {
      active: false,
      status: null,
      source: null,
    };

    try {
      const webhookToken =
        this.tokens[sessionId] || (await this.fetchWebhookToken(sessionId));

      if (!webhookToken) {
        this.logger.warn("⚠️ No se pudo obtener webhook_token", { sessionId });
        return returnDetailed ? response : false;
      }

      // 1️⃣ Cache local (invalidar si es para reconexión)
      if (!skipCache) {
        const cachedActive = this.stateManager.getFromLocalCache(sessionId, {
          skipForReconnect: forReconnect,
          forReconnect,
        });
        if (cachedActive !== null) {
          const status = this.stateManager.getCachedStatus(sessionId);
          response.status = status;
          response.source = "cache";
          response.active = status
            ? accepted.has(status)
            : Boolean(cachedActive);
          return returnDetailed ? response : response.active;
        }
      }

      // 2️⃣ Redis: "active" o "connecting" son válidos para reconexión
      const redisStatus = await this.stateManager.getStatusFromRedis(sessionId);
      if (redisStatus) {
        this.stateManager.setLocalSessionState(sessionId, redisStatus, {
          active: redisStatus === "active",
          reconnectEligible:
            redisStatus === "active" || redisStatus === "connecting",
        });

        response.status = redisStatus;
        response.source = "redis";
        response.active = accepted.has(redisStatus);
        return returnDetailed ? response : response.active;
      }

      // 3️⃣ Laravel
      const estado = await this.getQrStatus(webhookToken, sessionId);

      if (estado) {
        this.stateManager.setLocalSessionState(sessionId, estado, {
          active: estado === "active",
          reconnectEligible: estado === "active" || estado === "connecting",
        });

        response.status = estado;
        response.source = "laravel";
        response.active = accepted.has(estado);
      }

      return returnDetailed ? response : response.active;
    } catch (err) {
      this.logger.error("❌ Error verificando sessionId en Laravel", err, {
        sessionId,
      });
      return returnDetailed ? response : false;
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
