/**
 * 📱 Módulo de Gestión de WhatsApp
 *
 * Gestiona:
 * - Creación y gestión de sesiones de WhatsApp
 * - Conexión/desconexión
 * - Generación y manejo de QR codes
 * - Throttling y deduplicación de QR
 * - Restauración de sesiones
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

class WhatsAppManager {
  constructor(
    axios,
    laravelApi,
    logger,
    queueManager,
    cacheManager,
    batchQueueManager
  ) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;

    this.queueManager = queueManager;
    this.cacheManager = cacheManager;
    this.batchQueueManager = batchQueueManager;

    // Token Laravel (webhook_token) por sessionId
    this.tokens = {};                 // sessionId → webhook_token

    // Cache local de estado de sesión
    this.sessionActiveCache = new Map(); // sessionId → { active, timestamp }

    // Contador de QR enviados por sesión (máx 3)
    this.qrSendCount = new Map();     // sessionId → count

    // Almacenamiento de sesiones activas (Baileys sockets)
    this.sessions = {};               // sessionId → { sock, state, saveCreds, userId, webhookToken }

    // Control de QR
    this.qrTimeouts = {};            // sessionId → timeoutId
    this.lastQrSent = new Map();     // sessionId → qr string
    this.lastQrAt = new Map();       // sessionId → timestamp ms
    this.inflightQr = new Map();     // sessionId → bool

    // Configuración
    this.QR_THROTTLE_MS = 5000;      // 5 segundos entre QR enviados
    this.QR_EXPIRES_MS = 120000;     // 120 segundos de vida del QR
    this.MAX_QR_RETRIES = 3;
    this.BACKOFF_BASE = 600;
    this.BACKOFF_JITTER = 400;
    this.SESSION_ACTIVE_CACHE_TTL = 30000; // 30s

    this.authDir = path.join(__dirname, "..", "auth");
  }

  /**
   * ⏱️ Helper para dormir
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 🌐 Envía datos a Laravel con reintentos
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

        await this.sleep(backoff);
      }
    }
  }

  /**
   * 🔍 Obtiene el estado del QR en Laravel usando webhook_token
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
   * ✅ Verifica si una sesión está activa en Laravel (CON CACHE, usando webhook_token)
   */
  async isSessionActive(sessionId) {
    try {
      // 1️⃣ Recuperar webhook_token asociado
      let webhookToken = this.tokens[sessionId];

      if (!webhookToken) {
        webhookToken = await this.fetchWebhookToken(sessionId);
      }

      if (!webhookToken) {
        this.logger.warn("⚠️ No se pudo obtener webhook_token", { sessionId });
        return false;
      }

      // 2️⃣ Revisar caché local
      const cachedActive = this.sessionActiveCache.get(sessionId);
      if (cachedActive !== undefined) {
        const { active, timestamp } = cachedActive;
        if (Date.now() - timestamp < this.SESSION_ACTIVE_CACHE_TTL) {
          return active;
        }
      }

      // 3️⃣ Consultar caché Redis (status simple)
      const cachedStatus = await this.cacheManager.getStatus(sessionId);
      if (cachedStatus && cachedStatus !== "inactive") {
        this.sessionActiveCache.set(sessionId, {
          active: true,
          timestamp: Date.now(),
        });
        return true;
      }

      // 4️⃣ Consultar Laravel por TOKEN
      const estado = await this.getQrStatus(webhookToken, sessionId);
      const isActive = !!estado && estado !== "inactive";

      // Cachear
      this.sessionActiveCache.set(sessionId, {
        active: isActive,
        timestamp: Date.now(),
      });

      return isActive;
    } catch (err) {
      this.logger.error("❌ Error verificando sessionId en Laravel", err, {
        sessionId,
      });

      // Fail-safe: consideramos activa para no romper flujo
      return true;
    }
  }

  /**
   * 📲 Maneja la generación y envío de QR codes (CON BATCH, CACHE Y LÍMITE DE 3)
   */
  async handleQrCode(qr, sessionId, connection) {
    if (!qr) return;
    if (connection === "open") return;

    // Inicializar contador si no existe
    if (!this.qrSendCount.has(sessionId)) {
      this.qrSendCount.set(sessionId, 0);
    }
    const currentCount = this.qrSendCount.get(sessionId) || 0;

    // Límite de 3 QR enviados por ciclo
    if (currentCount >= 3) {
      this.logger.warn(
        "⚠️ Límite de 3 QR alcanzado, no se enviarán más",
        { sessionId }
      );
      return;
    }

    // Verificar si la sesión sigue activa en Laravel
    const active = await this.isSessionActive(sessionId);
    if (!active) {
      this.logger.warn(
        "⚠️ Sesión inactiva en Laravel, ignorando QR",
        { sessionId }
      );
      return;
    }

    // Verificar si el QR cambió respecto al cache
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

      // Guardar QR en cache (Redis)
      await this.cacheManager.setQr(sessionId, qr);

      // Mandar al batch (Laravel guarda /qr y actualiza estado)
      this.batchQueueManager.addQr(sessionId, qr);
      this.batchQueueManager.addStatus(sessionId, "pending", "normal");

      // Actualizar estado local
      this.lastQrSent.set(sessionId, qr);
      this.lastQrAt.set(sessionId, now);
      this.qrSendCount.set(sessionId, currentCount + 1);

      this.logger.info("📤 QR enviado (#" + (currentCount + 1) + ")", {
        sessionId,
      });

      // Configurar expiración de este QR
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
   * ⏰ Configura la expiración del QR
   */
  setupQrExpiration(sessionId) {
    // Limpiar timeout anterior si existe
    if (this.qrTimeouts[sessionId]) {
      clearTimeout(this.qrTimeouts[sessionId]);
    }

    this.qrTimeouts[sessionId] = setTimeout(async () => {
      try {
        const estado = await this.cacheManager.getStatus(sessionId);

        if (estado === "pending") {
          // Notificar a Laravel → inactive
          this.batchQueueManager.addStatus(sessionId, "inactive", "normal");
          await this.cacheManager.setStatus(sessionId, "inactive");

          // Limpiar estado local de QR y contador
          this.clearQrState(sessionId);
          this.qrSendCount.set(sessionId, 0);

          this.logger.info("⏰ QR expirado → estado reseteado", { sessionId });
        }
      } catch (err) {
        this.logger.error("❌ Error al expirar QR", err, { sessionId });
      } finally {
        delete this.qrTimeouts[sessionId];
      }
    }, this.QR_EXPIRES_MS);
  }

  /**
   * 🧹 Limpia el estado de QR para una sesión
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
   * ✅ Maneja la sesión abierta (CON BATCH)
   */
  async handleSessionOpen(sessionId) {
    this.logger.info("✅ Sesión abierta", { sessionId });

    // Limpiar estado de QR y contador
    this.clearQrState(sessionId);

    // Actualizar caché
    await this.cacheManager.setStatus(sessionId, "active");
    this.sessionActiveCache.set(sessionId, {
      active: true,
      timestamp: Date.now(),
    });

    // Notificar a Laravel estado activo (HIGH priority)
    this.batchQueueManager.addStatus(sessionId, "active", "high");

    this.logger.info("✅ Estado actualizado a active (batch)", { sessionId });
  }

  /**
   * 🔌 Maneja el cierre de sesión
   */
  async handleSessionClose(sessionId, userId, lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    this.logger.info("🔌 Sesión cerrada", { sessionId, statusCode, loggedOut });

    // Limpiar estado de QR y contador
    this.clearQrState(sessionId);

    // Actualizar caché
    await this.cacheManager.setStatus(
      sessionId,
      loggedOut ? "inactive" : "connecting"
    );
    this.sessionActiveCache.delete(sessionId);

    if (loggedOut) {
      // Usuario desconectado manualmente → marcar inactive (HIGH)
      this.batchQueueManager.addStatus(sessionId, "inactive", "high");
      this.logger.info("✅ Sesión marcada como inactive (logout)", {
        sessionId,
      });

      // Limpiar de memoria
      delete this.sessions[sessionId];
    } else {
      // Reintentar solo si Laravel dice que sigue activa
      const active = await this.isSessionActive(sessionId);

      if (active) {
        this.logger.info("🔄 Reintentando conexión", { sessionId });

        // Pequeño delay para no hacer hammer
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
          "⚠️ SessionId inactivo en Laravel, no se reintenta conexión",
          { sessionId }
        );
        this.batchQueueManager.addStatus(sessionId, "inactive", "high");
      }
    }
  }

  /**   * 🧹 Limpia sesiones muertas automáticamente
   */
  async cleanupDeadSessions() {
  const allSessions = Object.keys(this.sessions);

  for (const sessionId of allSessions) {
    const active = await this.isSessionActive(sessionId);

    if (!active) {
      this.logger.warn("🗑️ Eliminando sesión inactiva automáticamente", { sessionId });
      await this.deleteSession(sessionId);
    }
  }
}


  /**
   * 🚀 Inicia una sesión de WhatsApp
   *
   * IMPORTANTE:
   *  - NO borra el directorio auth aquí.
   *  - Si quieres QR NUEVO, borra el auth en /start (index.js) ANTES de llamar a esto.
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

      // Directorio de sesión
      const sessionDir = path.join(this.authDir, sessionId);

      // NO borrar aquí. Solo crear si no existe.
      if (!fs.existsSync(sessionDir)) {
        this.logger.info("📁 Creando directorio de sesión", { sessionDir });
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      // Cargar credenciales (o crear nuevas si es primera vez)
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      // const { version } = await fetchLatestBaileysVersion();
      const version = [2, 2413, 7]; // versión estable aceptada por Android


      // Crear socket WhatsApp
      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        // browser: ["boty-SaaS", "Chrome", "1.0"],
        browser: ["Desktop", "Chrome", "108.0.5359.124"],

        printQRInTerminal: false,
      });

      // 📡 Event: Actualización de conexión
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

      // 📩 Event: Mensajes entrantes
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

      // 🔄 Event: Actualización de credenciales
      sock.ev.on("creds.update", saveCreds);

      // Guardar socket en memoria
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
   * 🔄 Restaura todas las sesiones activas desde Laravel
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
   * 🗑️ Elimina una sesión
   */
  async deleteSession(sessionId) {
    try {
      this.logger.info("🗑️ Eliminando sesión", { sessionId });

      // Cerrar socket si existe
      if (this.sessions[sessionId]?.sock) {
        const { sock } = this.sessions[sessionId];
        try {
          sock.end();
        } catch (_) {}
        delete this.sessions[sessionId];
      }

      // Limpiar estado de QR y contador
      this.clearQrState(sessionId);

      // Eliminar archivos de autenticación
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
   * 📊 Obtiene información de una sesión
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
   * 📋 Lista todas las sesiones activas
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

module.exports = WhatsAppManager;
