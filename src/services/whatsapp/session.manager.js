// src/services/whatsapp/session.manager.js

/**
 * 👥 Gestor de Sesiones
 *
 * Responsabilidad:
 * - Crear y eliminar sesiones de WhatsApp
 * - Gestionar lista de sesiones activas
 * - Restaurar sesiones desde Laravel
 * - Obtener información de sesiones
 */

const { sleep } = require("../../utils/helpers");

class SessionManager {
  constructor(
    socketFactory,
    connectionManager,
    qrManager,
    queueManager,
    axios,
    laravelApi,
    logger,
    stateManager,
    config = {}
  ) {
    this.socketFactory = socketFactory;
    this.connectionManager = connectionManager;
    this.qrManager = qrManager;
    this.queueManager = queueManager;
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.stateManager = stateManager;
    this.config = config;

    // Sockets activos
    this.sessions = {}; // sessionId → { sock, state, saveCreds, userId, webhookToken, reconnectAttempts, reconnecting }

    // Configuración
    this.MAX_RETRIES = 4;
    this.BACKOFF_BASE = 600;
    this.BACKOFF_JITTER = 400;

    this.cleanupConfig = {
      inactivityGraceMs: config?.cleanup?.inactivityGraceMs ?? 120000,
      consecutiveMissThreshold: config?.cleanup?.consecutiveMissThreshold ?? 3,
    };

    this.watchdogConfig = {
      intervalMs: config?.watchdog?.intervalMs ?? 60000,
      inactivityThresholdMs:
        config?.watchdog?.inactivityThresholdMs ?? 10 * 60 * 1000,
    };

    this.cleanupMissCounter = new Map();
  }

  /**
   * 🚀 Inicia una sesión de WhatsApp
   */
  async startSession(sessionId, userId, webhookToken) {
    try {
      this.logger.info("🚀 Iniciando sesión", { sessionId, userId });

      if (webhookToken) {
        this.connectionManager.setWebhookToken(sessionId, webhookToken);
      } else {
        this.logger.warn("⚠️ Iniciando sesión sin webhook_token", {
          sessionId,
        });
      }

      // Crear socket Baileys
      const { sock, state, saveCreds } = await this.socketFactory.createSocket(
        sessionId
      );

      // Vincular event handlers
      this.socketFactory.attachEventHandlers(sock, {
        onConnectionUpdate: async (update) => {
          await this.handleConnectionUpdate(update, sessionId, userId);
        },
        onMessagesUpsert: async (msgUpdate) => {
          await this.handleMessagesUpsert(msgUpdate, sessionId);
        },
        onCredsUpdate: saveCreds,
      });

      // Guardar sesión
      this.sessions[sessionId] = {
        sock,
        state,
        saveCreds,
        userId,
        webhookToken,
        reconnectAttempts: 0,
        reconnecting: false,
        reconnectTask: null,
        lastHeartbeatAt: Date.now(),
      };

      await this.stateManager.updateHeartbeat(sessionId);

      this.logger.info("✅ Sesión iniciada correctamente", { sessionId });

      return sock;
    } catch (error) {
      this.logger.error("❌ Error iniciando sesión", error, {
        sessionId,
        userId,
      });
      throw error;
    }
  }

  /**
   * 📡 Maneja actualizaciones de conexión
   */
  async handleConnectionUpdate(update, sessionId, userId) {
    const { connection, lastDisconnect, qr } = update;

    this.logger.info("📡 Actualización de conexión", {
      connection,
      sessionId,
    });

    await this.recordHeartbeat(sessionId, "connection.update");

    if (qr) {
      await this.qrManager.handleQrCode(qr, sessionId, connection);
    }

    if (connection === "open") {
      await this.connectionManager.handleSessionOpen(sessionId);
    }

    if (connection === "close") {
      await this.connectionManager.handleSessionClose(
        sessionId,
        userId,
        lastDisconnect
      );
    }
  }

  async recordHeartbeat(sessionId, source = "event") {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }

    const timestamp = Date.now();
    session.lastHeartbeatAt = timestamp;

    try {
      await this.stateManager.updateHeartbeat(sessionId, timestamp);
    } catch (error) {
      this.logger.warn("⚠️ No se pudo registrar heartbeat", {
        sessionId,
        source,
        error: error?.message,
      });
    }
  }

  /**
   * 💬 Maneja mensajes entrantes
   */
  async handleMessagesUpsert(msgUpdate, sessionId) {
    try {
      await this.queueManager.addMessageToQueue(msgUpdate, sessionId);
      await this.recordHeartbeat(sessionId, "message");
    } catch (error) {
      this.logger.error("❌ Error agregando mensaje a cola", error, {
        messageId: msgUpdate.messages[0]?.key?.id,
        sessionId,
      });
    }
  }

  /**
   * 🔄 Restaura sesiones activas desde Laravel
   */
  async restoreSessions() {
    try {
      this.logger.info("🔄 Restaurando sesiones activas...");

      const { data: accounts } = await this.axios.get(
        `${this.laravelApi}/whatsapp/accounts/active`
      );

      if (!accounts || accounts.length === 0) {
        this.logger.info("ℹ️ No hay cuentas activas para restaurar");
        return;
      }

      this.logger.info(`📋 Encontradas ${accounts.length} cuentas activas`);

      for (const account of accounts) {
        try {
          this.logger.info("🔄 Restaurando sesión", {
            accountId: account.id,
            sessionId: account.session_id,
          });

          if (account.webhook_token) {
            this.connectionManager.setWebhookToken(
              account.session_id,
              account.webhook_token
            );
          } else {
            this.logger.warn("⚠️ Cuenta activa sin webhook_token", {
              accountId: account.id,
              sessionId: account.session_id,
            });
          }

          await this.startSession(
            account.session_id,
            account.user_id,
            account.webhook_token
          );
        } catch (err) {
          this.logger.error("❌ Error restaurando sesión", err, {
            accountId: account.id,
          });
        }
      }

      this.logger.info("✅ Proceso de restauración completado");
    } catch (err) {
      this.logger.error("❌ Error restaurando sesiones", err);
    }
  }

  /**
   * 🗑️ Elimina una sesión
   * @param {boolean} preserveAuth - Si es true, no elimina credenciales (para shutdown)
   */
  async deleteSession(sessionId, preserveAuth = false) {
    try {
      this.logger.info("🗑️ Eliminando sesión", { sessionId, preserveAuth });

      const session = this.sessions[sessionId];
      if (session?.sock) {
        if (preserveAuth) {
          // 🔌 Solo cerrar socket sin logout (para shutdown/reinicio)
          try {
            session.sock.end();
            this.logger.info("🔌 Socket cerrado (credenciales preservadas)", {
              sessionId,
            });
          } catch (err) {
            this.logger.warn("⚠️ Error cerrando socket (ignorado)", {
              sessionId,
            });
          }
        } else {
          // 🚪 Logout completo (para eliminación manual)
          await this.socketFactory.closeSocket(session.sock);
        }
        delete this.sessions[sessionId];
      }

      this.qrManager.clearQrState(sessionId);

      // Solo eliminar auth si NO estamos preservando
      if (!preserveAuth) {
        this.socketFactory.removeAuthDir(sessionId);
      } else {
        this.logger.info("💾 Credenciales preservadas para próximo reinicio", {
          sessionId,
        });
      }

      this.logger.info("✅ Sesión eliminada", { sessionId });
    } catch (error) {
      this.logger.error("❌ Error eliminando sesión", error, { sessionId });
      throw error;
    }

    this.cleanupMissCounter.delete(sessionId);
    await this.stateManager.resetCleanupMiss(sessionId);
  }

  /**
   * 📊 Obtiene información de una sesión
   */
  getSessionInfo(sessionId) {
    const session = this.sessions[sessionId];
    const statusSnapshot = this.stateManager?.getStatusSnapshot(sessionId);

    return {
      exists: !!session,
      connected: session?.sock?.user ? true : false,
      user: session?.sock?.user || null,
      sessionId,
      status: statusSnapshot?.status || null,
      statusUpdatedAt: statusSnapshot?.updatedAt || null,
      reconnecting: Boolean(session?.reconnecting),
      lastHeartbeatAt: session?.lastHeartbeatAt || null,
    };
  }

  /**
   * 📋 Lista todas las sesiones activas
   */
  listActiveSessions() {
    return Object.keys(this.sessions).map((sessionId) =>
      this.getSessionInfo(sessionId)
    );
  }

  /**
   * 🛑 Cierra todas las sesiones
   * @param {boolean} preserveAuth - Si es true, preserva credenciales (para shutdown)
   */
  async closeAllSessions(preserveAuth = false) {
    this.logger.info("🛑 Cerrando todas las sesiones...", { preserveAuth });

    const sessionIds = Object.keys(this.sessions);

    for (const sessionId of sessionIds) {
      try {
        await this.deleteSession(sessionId, preserveAuth);
      } catch (err) {
        this.logger.error("❌ Error cerrando sesión", err, { sessionId });
      }
    }

    this.logger.info("✅ Todas las sesiones cerradas");
  }

  /**
   * 🧹 Limpia sesiones muertas
   */
  async cleanupDeadSessions() {
    const now = Date.now();
    const allSessions = Object.keys(this.sessions);

    for (const sessionId of allSessions) {
      const session = this.sessions[sessionId];
      if (!session) {
        continue;
      }

      if (session.reconnecting) {
        this.logger.debug("⏭️ Omitiendo cleanup: reconexión activa", {
          sessionId,
        });
        continue;
      }

      const status = await this.connectionManager.isSessionActive(sessionId, {
        forReconnect: true,
        returnDetailed: true,
        acceptedStatuses: ["active", "connecting", "pending"],
        skipCache: true,
      });

      if (status.active) {
        await this.resetCleanupCounter(sessionId);
        continue;
      }

      const lastHeartbeat =
        session.lastHeartbeatAt ||
        (await this.stateManager.getLastHeartbeat(sessionId));
      const idleMs = lastHeartbeat ? now - lastHeartbeat : null;

      if (idleMs !== null && idleMs < this.cleanupConfig.inactivityGraceMs) {
        continue;
      }

      const miss = await this.incrementCleanupMiss(sessionId);

      await this.stateManager.recordTransition(
        sessionId,
        "cleanup_inactive_detected",
        {
          miss,
          idleMs,
          status: status.status,
        }
      );

      if (miss < this.cleanupConfig.consecutiveMissThreshold) {
        continue;
      }

      await this.stateManager.recordTransition(
        sessionId,
        "cleanup_force_delete",
        {
          miss,
          status: status.status,
        }
      );

      this.logger.warn("🗑️ Eliminando sesión inactiva automáticamente", {
        sessionId,
        miss,
        idleMs,
      });

      try {
        await this.deleteSession(sessionId);
        await this.stateManager.updateSessionStatus(
          sessionId,
          "inactive",
          "high"
        );
      } catch (err) {
        this.logger.error("❌ Error cerrando sesión", err, { sessionId });
      } finally {
        await this.resetCleanupCounter(sessionId);
      }
    }
  }

  /**
   * ⏱️ Watchdog de heartbeats
   */
  async runWatchdog() {
    const threshold = this.watchdogConfig?.inactivityThresholdMs;
    if (!threshold) {
      return;
    }

    const now = Date.now();
    const sessions = Object.entries(this.sessions);

    for (const [sessionId, session] of sessions) {
      if (!session) continue;
      if (session.reconnecting) continue;

      const lastHeartbeat =
        session.lastHeartbeatAt ||
        (await this.stateManager.getLastHeartbeat(sessionId));
      if (!lastHeartbeat) continue;

      const idleMs = now - lastHeartbeat;
      if (idleMs < threshold) continue;

      await this.stateManager.recordTransition(
        sessionId,
        "watchdog_idle_detected",
        {
          idleMs,
          threshold,
        }
      );

      this.logger.warn("⏰ Watchdog solicitando reconexión", {
        sessionId,
        idleMs,
      });

      this.connectionManager.requestReconnect(sessionId, session.userId, {
        reason: "watchdog",
        idleMs,
      });
    }
  }

  async incrementCleanupMiss(sessionId) {
    const misses = (this.cleanupMissCounter.get(sessionId) || 0) + 1;
    this.cleanupMissCounter.set(sessionId, misses);
    await this.stateManager.incrementCleanupMiss(sessionId);
    return misses;
  }

  async resetCleanupCounter(sessionId) {
    this.cleanupMissCounter.delete(sessionId);
    await this.stateManager.resetCleanupMiss(sessionId);
  }

  /**
   * 🔍 Obtiene una sesión específica
   */
  getSession(sessionId) {
    return this.sessions[sessionId];
  }

  /**
   * 🆕 Inicializa una nueva sesión vacía
   */
  initializeSession(sessionId) {
    this.sessions[sessionId] = {
      sock: null,
      state: null,
      saveCreds: null,
      userId: null,
      webhookToken: null,
      reconnectAttempts: 0,
      reconnecting: false,
      reconnectTask: null,
      lastHeartbeatAt: null,
    };
    return this.sessions[sessionId];
  }

  /**
   * 🗑️ Remueve una sesión de memoria
   */
  removeSession(sessionId) {
    delete this.sessions[sessionId];
  }

  /**
   * 🧰 Helper para POST a Laravel con reintentos
   */
  async postLaravel(pathUrl, body, attempts = this.MAX_RETRIES) {
    let tryNum = 0;

    while (true) {
      tryNum++;
      try {
        return await this.queueManager.executeWithCircuitBreaker(() =>
          this.axios.post(`${this.laravelApi}${pathUrl}`, body)
        );
      } catch (e) {
        const status = e?.response?.status;
        const retriable =
          status === 429 || (status >= 500 && status < 600) || !status;

        if (!retriable || tryNum >= attempts) {
          throw e;
        }

        const backoff =
          this.BACKOFF_BASE * Math.pow(2, tryNum - 1) +
          Math.floor(Math.random() * this.BACKOFF_JITTER);

        this.logger.warn(`🔄 Retry ${tryNum}/${attempts} ${pathUrl}`, {
          status: status || "network",
          backoff,
        });

        await sleep(backoff);
      }
    }
  }
}

module.exports = SessionManager;
