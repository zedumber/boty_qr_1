// src/services/whatsapp.service.js

/**
 * 🧠 Servicio de WhatsApp (Baileys)
 *
 * Responsabilidades:
 * - Crear y gestionar sesiones de WhatsApp
 * - Manejar conexión / reconexión
 * - Generar y enviar QR (con throttle + límite)
 * - Mantener estados en cache + Laravel (vía batch)
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const { sleep } = require("../utils/helpers");

class WhatsAppService {
  /**
   * @param {import("axios").AxiosInstance} axios
   * @param {string} laravelApi
   * @param {object} logger
   * @param {QueueManager} queueManager
   * @param {CacheManager} cacheManager
   * @param {BatchQueueManager} batchQueueManager
   */
  constructor(axios, laravelApi, logger, queueManager, cacheManager, batchQueueManager) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.queueManager = queueManager;
    this.cacheManager = cacheManager;
    this.batchQueueManager = batchQueueManager;

    // Token Laravel (webhook_token) por sessionId
    this.tokens = {};                  // sessionId → webhook_token

    // Cache local de estado de sesión
    this.sessionActiveCache = new Map(); // sessionId → { active, timestamp }

    // Contador de QR enviados por sesión
    this.qrSendCount = new Map();      // sessionId → count

    // Sockets activos
    this.sessions = {};                // sessionId → { sock, state, saveCreds, userId, webhookToken }

    // Estado de QR
    this.qrTimeouts = {};             // sessionId → timeoutId
    this.lastQrSent = new Map();      // sessionId → qr string
    this.lastQrAt = new Map();        // sessionId → timestamp ms
    this.inflightQr = new Map();      // sessionId → bool

    // Configuración interna
    this.QR_THROTTLE_MS = 5000;       // 5s entre QR
    this.QR_EXPIRES_MS = 60000;      // 60s vida QR
    this.MAX_QR_RETRIES = 4;
    this.BACKOFF_BASE = 600;
    this.BACKOFF_JITTER = 400;
    this.SESSION_ACTIVE_CACHE_TTL = 30000; // 30s

    this.authDir = path.join(__dirname, "..", "..", "auth");
  }

  /**
   * 🧰 Helper para POST a Laravel con reintentos y circuit breaker
   */
  async postLaravel(pathUrl, body, attempts = this.MAX_QR_RETRIES) {
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

  /**
   * 🔍 Obtiene estado de QR en Laravel usando webhook_token
   */
  async getQrStatus(webhookToken, sessionId) {
    if (!webhookToken && sessionId) {
      webhookToken = await this.fetchWebhookToken(sessionId);
    }

    if (!webhookToken) {
      this.logger.warn("⚠️ No existe webhook_token para la sesión", { sessionId });
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
   * 🔑 Obtiene y cachea el webhook_token asociado a un sessionId
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
   * ✅ Verifica si una sesión está activa (cache local + Redis + Laravel)
   */
 /**
 * ✅ Verifica si una sesión está activa
 *
 * @param {string} sessionId
 * @param {{ forReconnect?: boolean }} options
 *        - forReconnect = true → si está "pending" NO se considera activa
 */
async isSessionActive(sessionId, options = {}) {
  const { forReconnect = false } = options;

  try {
    let webhookToken = this.tokens[sessionId];

    if (!webhookToken) {
      webhookToken = await this.fetchWebhookToken(sessionId);
    }

    if (!webhookToken) {
      this.logger.warn("⚠️ No se pudo obtener webhook_token", { sessionId });
      return false;
    }

    // 1️⃣ Intentar con cache local de estados
    const cachedActive = this.sessionActiveCache.get(sessionId);
    if (cachedActive !== undefined) {
      const { active, timestamp } = cachedActive;
      if (Date.now() - timestamp < this.SESSION_ACTIVE_CACHE_TTL) {
        return active;
      }
    }

    // 2️⃣ Intentar con Redis
    const cachedStatus = await this.cacheManager.getStatus(sessionId);
    if (cachedStatus) {
      let isActiveCached;

      if (cachedStatus === "inactive") {
        isActiveCached = false;
      } else if (forReconnect && cachedStatus === "pending") {
        // 👈 para reconexión, pending = NO activo
        isActiveCached = false;
      } else {
        isActiveCached = true;
      }

      this.sessionActiveCache.set(sessionId, {
        active: isActiveCached,
        timestamp: Date.now(),
      });

      return isActiveCached;
    }

    // 3️⃣ Si no hay nada en Redis, preguntar a Laravel por TOKEN
    const estado = await this.getQrStatus(webhookToken, sessionId);

    let isActive;
    if (!estado || estado === "inactive") {
      isActive = false;
    } else if (forReconnect && estado === "pending") {
      // 👈 Igual regla para reconexión
      isActive = false;
    } else {
      isActive = true;
    }

    this.sessionActiveCache.set(sessionId, {
      active: isActive,
      timestamp: Date.now(),
    });

    return isActive;
  } catch (err) {
    this.logger.error("❌ Error verificando sessionId en Laravel", err, {
      sessionId,
    });

    // Antes devolvías true (muy agresivo).
    // Para evitar bucles, mejor ser conservador aquí:
    return false;
  }
}


  /**
   * 📲 Maneja la generación/envío de QR con límite + throttle + cache
   */
  async handleQrCode(qr, sessionId, connection) {
    if (!qr) return;
    // if (connection === "open") return;
    // Si está reconectando o cerrando → NO generar nuevos QR
  if (connection === "connecting" || connection === "close") {
    this.logger.debug("ℹ️ Ignorando QR porque la sesión está reconectando", {
      sessionId,
      connection,
    });
    return;
  }

  // Si la sesión ya abrió → NO generar QR
  if (connection === "open") return;

    if (!this.qrSendCount.has(sessionId)) {
      this.qrSendCount.set(sessionId, 0);
    }
    const currentCount = this.qrSendCount.get(sessionId) || 0;

    // Límite de 4 QR por ciclo
    if (currentCount >= 4) {
      this.logger.warn("⚠️ Límite de 4 QR alcanzado, no se enviarán más", {
        sessionId,
      });
      return;
    }

    const active = await this.isSessionActive(sessionId);
    if (!active) {
      this.logger.warn("⚠️ Sesión inactiva en Laravel, ignorando QR", {
        sessionId,
      });
      return;
    }

    const isNewQr = await this.cacheManager.isNewQr(sessionId, qr);
    if (!isNewQr) {
      this.logger.debug("ℹ️ QR duplicado, ignorado", { sessionId });
      return;
    }

    const lastAt = this.lastQrAt.get(sessionId) || 0;
    const now = Date.now();
    const canSend = now - lastAt >= this.QR_THROTTLE_MS;

    if (!canSend) {
      this.logger.debug("ℹ️ Throttle activo → ignorando QR", { sessionId });
      return;
    }

    if (this.inflightQr.get(sessionId)) {
      this.logger.debug("ℹ️ Envío de QR en curso, ignorando", { sessionId });
      return;
    }

    this.inflightQr.set(sessionId, true);

    try {
      this.logger.info("📲 Nuevo QR generado", { sessionId });

      await this.cacheManager.setQr(sessionId, qr);

      // BATCH hacia Laravel
      this.batchQueueManager.addQr(sessionId, qr);
      this.batchQueueManager.addStatus(sessionId, "pending", "normal");
      await this.cacheManager.setStatus(sessionId, "pending");

      this.lastQrSent.set(sessionId, qr);
      this.lastQrAt.set(sessionId, now);
      this.qrSendCount.set(sessionId, currentCount + 1);

      this.logger.info("📤 QR enviado (#" + (currentCount + 1) + ")", {
        sessionId,
      });

      this.setupQrExpiration(sessionId);
    } catch (err) {
      this.logger.error("❌ Error procesando QR", err, {
        sessionId,
        status: err?.response?.status,
      });
    } finally {
      this.inflightQr.set(sessionId, false);
    }
  }

  /**
   * ⏰ Expiración automática de QR
   */
  setupQrExpiration(sessionId) {
    if (this.qrTimeouts[sessionId]) {
      clearTimeout(this.qrTimeouts[sessionId]);
    }

    this.qrTimeouts[sessionId] = setTimeout(async () => {
      try {
        const estado = await this.cacheManager.getStatus(sessionId);

        if (estado === "pending") {
          this.batchQueueManager.addStatus(sessionId, "inactive", "normal");
          
          await this.cacheManager.setStatus(sessionId, "inactive");

          this.clearQrState(sessionId);
          this.qrSendCount.set(sessionId, 0);
          this.sessionActiveCache.delete(sessionId); // 👈 SOLUCIÓN

          // this.logger.info("⏰ QR expirado → estado reseteado", { sessionId });
        }
      } catch (err) {
        this.logger.error("❌ Error al expirar QR", err, { sessionId });
      } finally {
        delete this.qrTimeouts[sessionId];
      }
    }, this.QR_EXPIRES_MS);
  }

  /**
   * 🧹 Limpia estado de QR
   */
  clearQrState(sessionId) {
    if (this.qrTimeouts[sessionId]) {
      clearTimeout(this.qrTimeouts[sessionId]);
      delete this.qrTimeouts[sessionId];
    }

    this.lastQrSent.delete(sessionId);
    this.lastQrAt.delete(sessionId);
    this.inflightQr.delete(sessionId);
    this.qrSendCount.set(sessionId, 0);
  }

  /**
   * ✅ Cuando la sesión se abre correctamente
   */
  async handleSessionOpen(sessionId) {
    this.logger.info("✅ Sesión abierta", { sessionId });

    this.clearQrState(sessionId);

    await this.cacheManager.setStatus(sessionId, "active");
    this.sessionActiveCache.set(sessionId, {
      active: true,
      timestamp: Date.now(),
    });

    this.batchQueueManager.addStatus(sessionId, "active", "high");

    this.logger.info("✅ Estado actualizado a active (batch)", { sessionId });
  }

  /**
   * 🔌 Cuando la sesión se cierra
   */
  async handleSessionClose(sessionId, userId, lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    this.logger.info("🔌 Sesión cerrada", { sessionId, statusCode, loggedOut });

    this.clearQrState(sessionId);

    await this.cacheManager.setStatus(
      sessionId,
      loggedOut ? "inactive" : "connecting"
    );
    this.sessionActiveCache.delete(sessionId);

    if (loggedOut) {
      this.batchQueueManager.addStatus(sessionId, "inactive", "high");
      this.logger.info("✅ Sesión marcada como inactive (logout)", {
        sessionId,
      });
      delete this.sessions[sessionId];
    } else {
  // 👇 Para reconectar, pending cuenta como NO activo
  const active = await this.isSessionActive(sessionId, { forReconnect: true });

  if (active) {
    this.logger.info("🔄 Reintentando conexión", { sessionId });

    setTimeout(() => {
      this.startSession(sessionId, userId, this.tokens[sessionId]).catch(
        (err) => {
          this.logger.error(
            "❌ Error reintentando conexión de sesión",
            err,
            { sessionId }
          );
        }
      );
    }, 2000);
  } else {
    this.logger.warn(
      "⚠️ SessionId inactivo o solo en pending, no se reintenta conexión",
      { sessionId }
    );
    this.batchQueueManager.addStatus(sessionId, "inactive", "high");
  }
}
  }
  /**
   * 🧹 Limpieza de sesiones muertas
   */
  async cleanupDeadSessions() {
    const allSessions = Object.keys(this.sessions);

    for (const sessionId of allSessions) {
      const active = await this.isSessionActive(sessionId);

      if (!active) {
        this.logger.warn("🗑️ Eliminando sesión inactiva automáticamente", {
          sessionId,
        });
        await this.deleteSession(sessionId);
      }
    }
  }

  /**
   * 🚀 Inicia una sesión de WhatsApp
   */
  async startSession(sessionId, userId, webhookToken) {
    try {
      this.logger.info("🚀 Iniciando sesión", { sessionId, userId });

      const resolvedWebhookToken = webhookToken || this.tokens[sessionId];

      if (resolvedWebhookToken) {
        this.tokens[sessionId] = resolvedWebhookToken;
      } else {
        this.logger.warn("⚠️ Iniciando sesión sin webhook_token", {
          sessionId,
        });
      }

      const sessionDir = path.join(this.authDir, sessionId);

      if (!fs.existsSync(sessionDir)) {
        this.logger.info("📁 Creando directorio de sesión", { sessionDir });
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["boty-SaaS", "Chrome", "1.0"],
        printQRInTerminal: false,
      });

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        this.logger.info("📡 Actualización de conexión", {
          connection,
          sessionId,
        });

        if (qr) {
          await this.handleQrCode(qr, sessionId, connection);
        }

        if (connection === "open") {
          await this.handleSessionOpen(sessionId);
        }

        if (connection === "close") {
          await this.handleSessionClose(sessionId, userId, lastDisconnect);
        }
      });

      sock.ev.on("messages.upsert", async (msgUpdate) => {
        try {
          await this.queueManager.addMessageToQueue(msgUpdate, sessionId);
        } catch (error) {
          this.logger.error("❌ Error agregando mensaje a cola", error, {
            messageId: msgUpdate.messages[0]?.key?.id,
            sessionId,
          });
        }
      });

      sock.ev.on("creds.update", saveCreds);

      this.sessions[sessionId] = {
        sock,
        state,
        saveCreds,
        userId,
        webhookToken: resolvedWebhookToken,
      };

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
            this.tokens[account.session_id] = account.webhook_token;
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
   * 🗑️ Elimina una sesión (cerrar socket + borrar auth)
   */
  async deleteSession(sessionId) {
    try {
      this.logger.info("🗑️ Eliminando sesión", { sessionId });

      if (this.sessions[sessionId]?.sock) {
        const { sock } = this.sessions[sessionId];
        try {
          await sock.logout();
        } catch (_) {
          this.logger.warn("⚠️ Error en logout (ignorado)", { sessionId });
        }
        delete this.sessions[sessionId];
      }

      this.clearQrState(sessionId);

      const sessionDir = path.join(this.authDir, sessionId);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }

      this.logger.info("✅ Sesión eliminada", { sessionId });
    } catch (error) {
      this.logger.error("❌ Error eliminando sesión", error, { sessionId });
      throw error;
    }
  }

  /**
   * 📊 Info de sesión
   */
  getSessionInfo(sessionId) {
    const session = this.sessions[sessionId];

    return {
      exists: !!session,
      connected: session?.sock?.user ? true : false,
      user: session?.sock?.user || null,
      sessionId,
    };
  }

  /**
   * 📋 Lista de sesiones activas
   */
  listActiveSessions() {
    return Object.keys(this.sessions).map((sessionId) =>
      this.getSessionInfo(sessionId)
    );
  }

  /**
   * 🛑 Cierra todas las sesiones
   */
  async closeAllSessions() {
    this.logger.info("🛑 Cerrando todas las sesiones...");

    const sessionIds = Object.keys(this.sessions);

    for (const sessionId of sessionIds) {
      try {
        await this.deleteSession(sessionId);
      } catch (err) {
        this.logger.error("❌ Error cerrando sesión", err, { sessionId });
      }
    }

    this.logger.info("✅ Todas las sesiones cerradas");
  }
}

module.exports = WhatsAppService;
