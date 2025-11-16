/**
 * 📱 Módulo de Gestión de WhatsApp (PRO MAX)
 *
 * Gestiona:
 * - Creación y gestión de sesiones de WhatsApp
 * - Conexión/desconexión con reintentos y backoff
 * - Generación y manejo de QR codes
 * - Throttling, deduplicación y control de estado de QR
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
  constructor(axios, laravelApi, logger, queueManager) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.queueManager = queueManager;

    // Sesiones vivas en memoria
    this.sessions = {};

    // Control de QR por sesión
    this.qrTimeouts = {};
    this.lastQrSent = new Map();
    this.lastQrAt = new Map();
    this.inflightQr = new Map();
    this.sessionQrStatus = new Map(); // pending | active | inactive

    this.pendingTimeouts = new Map(); // sessionId -> timeoutId
    this.PENDING_TIMEOUT_MS = 45000; // 45 segundos


    // Control de reconexión por sesión
    this.reconnectState = new Map(); // { attempts, timeoutId }

    // Configuración QR
    this.QR_THROTTLE_MS = 30000; // 30s entre envíos del mismo QR
    this.QR_EXPIRES_MS = 60000; // 60s de vigencia del QR
    this.MAX_QR_RETRIES = 3;
    this.BACKOFF_BASE = 600;
    this.BACKOFF_JITTER = 400;

    // Configuración reconexión
    this.RECONNECT_BASE_DELAY = 5000; // 5s base
    this.RECONNECT_MAX_DELAY = 60000; // 60s máximo
    this.MAX_RECONNECT_ATTEMPTS = 5;

    this.authDir = path.join(__dirname, "..", "auth");

    // Cache de versión de WhatsApp Web
    this.cachedVersion = null;
    this.fetchingVersionPromise = null;
  }

  /**
   * ⏱️ Helper para dormir
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 🌐 Envía datos a Laravel con reintentos usando el Circuit Breaker
   */
  async postLaravel(path, body, attempts = this.MAX_QR_RETRIES) {
    let tryNum = 0;

    while (true) {
      tryNum++;
      try {
        return await this.queueManager.executeWithCircuitBreaker(() =>
          this.axios.post(`${this.laravelApi}${path}`, body)
        );
      } catch (e) {
        const status = e?.response?.status;
        const retriable =
          status === 429 || (status >= 500 && status < 600) || !status;

        // Si no es reintentable o ya agotamos intentos, lanzamos
        if (!retriable || tryNum >= attempts) {
          throw e;
        }

        // Backoff exponencial + jitter
        const backoff =
          this.BACKOFF_BASE * Math.pow(2, tryNum - 1) +
          Math.floor(Math.random() * this.BACKOFF_JITTER);

        this.logger.warn(`🔄 Retry ${tryNum}/${attempts} ${path}`, {
          status: status || "network",
          backoff,
        });

        await this.sleep(backoff);
      }
    }
  }

  /**
   * 🔍 (Opcional) Obtiene estado del QR en Laravel
   */
  async getQrStatus(sessionId) {
    try {
      const { data } = await this.axios.get(
        `${this.laravelApi}/whatsapp/status/${sessionId}`
      );
      return data?.estado_qr;
    } catch (error) {
      this.logger.error("❌ Error obteniendo estado QR", error, { sessionId });
      throw error;
    }
  }

  /**
   * ✅ Verifica si una sesión está activa en memoria
   */
  async isSessionActive(sessionId) {
    const existsInMemory = !!this.sessions[sessionId];

    if (!existsInMemory) {
      this.logger.warn("⚠️ isSessionActive: sesión no existe en memoria", {
        sessionId,
      });
      return false;
    }

    // Si quieres revalidar contra Laravel, podrías usar getQrStatus aquí.
    return true;
  }

  /**
   * 🧠 Obtiene la versión de WhatsApp Web una vez y la cachea
   */
  async getBaileysVersionCached() {
    if (this.cachedVersion) {
      return this.cachedVersion;
    }

    if (this.fetchingVersionPromise) {
      return this.fetchingVersionPromise;
    }

    this.fetchingVersionPromise = (async () => {
      const { version } = await fetchLatestBaileysVersion();
      this.cachedVersion = version;
      this.fetchingVersionPromise = null;
      this.logger.info("ℹ️ Versión de WhatsApp Web obtenida", { version });
      return version;
    })();

    return this.fetchingVersionPromise;
  }

  /**
   * 📲 Maneja generación y envío de QR codes
   */
  async handleQrCode(qr, sessionId, connection) {
    // Si la conexión ya está abierta, ignoramos QR
    if (!qr || connection === "open") return;

    const active = await this.isSessionActive(sessionId);
    if (!active) return;

    // ⛔ Anti-spam: si ya está en pending, no volvemos a generar/enviar QR
    const currentState = this.sessionQrStatus.get(sessionId);
    if (currentState === "pending") {
      this.logger.info("⏳ Sesión ya en pending → QR ignorado", { sessionId });
      return;
    }

    const prevQr = this.lastQrSent.get(sessionId);
    const lastAt = this.lastQrAt.get(sessionId) || 0;
    const now = Date.now();

    // De-duplicación: solo si cambió el QR
    const isNewQr = qr !== prevQr;
    // Throttle: máximo 1 envío cada QR_THROTTLE_MS
    const canSend = now - lastAt >= this.QR_THROTTLE_MS;

    if (isNewQr && canSend && !this.inflightQr.get(sessionId)) {
      this.inflightQr.set(sessionId, true);

      try {
        this.logger.info("📲 Nuevo QR generado", { sessionId });

        // 1) Enviar QR a Laravel
        await this.postLaravel("/qr", {
          session_id: sessionId,
          qr,
        });

        // 2) Actualizar estado a pending
        await this.postLaravel("/whatsapp/status", {
          session_id: sessionId,
          estado_qr: "pending",
        });
        this.sessionQrStatus.set(sessionId, "pending");

        this.startPendingTimeout(sessionId); // <-- timeout de 45s

        // Marcar como enviado
        this.lastQrSent.set(sessionId, qr);
        this.lastQrAt.set(sessionId, now);

        this.logger.info("✅ QR enviado y estado actualizado a pending", {
          sessionId,
        });

        // 3) Configurar expiración del QR
        this.setupQrExpiration(sessionId);
      } catch (err) {
        const status = err?.response?.status;
        this.logger.error("❌ Error enviando QR/status", err, {
          sessionId,
          status,
        });
      } finally {
        this.inflightQr.set(sessionId, false);
      }
    } else {
      if (!isNewQr) {
        this.logger.info("ℹ️ QR duplicado, ignorando", { sessionId });
      } else if (!canSend) {
        this.logger.info("ℹ️ Throttle activo para QR", { sessionId });
      } else {
        this.logger.info("ℹ️ Envío de QR en curso", { sessionId });
      }
    }
  }

  /**
   * ⏰ Expiración de QR
   *
   * Marca la sesión como inactive si no se abre a tiempo.
   */
  setupQrExpiration(sessionId) {
    // Limpiar timeout anterior
    if (this.qrTimeouts[sessionId]) {
      clearTimeout(this.qrTimeouts[sessionId]);
    }

    this.qrTimeouts[sessionId] = setTimeout(async () => {
      try {
        await this.postLaravel("/whatsapp/status", {
          session_id: sessionId,
          estado_qr: "inactive",
        });

        this.sessionQrStatus.set(sessionId, "inactive");

        this.logger.info("⏰ QR expirado, estado marcado como inactive", {
          sessionId,
        });
      } catch (err) {
        this.logger.error("❌ Error al expirar QR", err, { sessionId });
      } finally {
        delete this.qrTimeouts[sessionId];
      }
    }, this.QR_EXPIRES_MS);
  }

  /**
   * 🧹 Limpia estado de QR de una sesión
   */
  clearQrState(sessionId) {
    if (this.qrTimeouts[sessionId]) {
      clearTimeout(this.qrTimeouts[sessionId]);
      delete this.qrTimeouts[sessionId];
    }

    this.lastQrSent.delete(sessionId);
    this.lastQrAt.delete(sessionId);
    this.inflightQr.delete(sessionId);

    // Por defecto, si limpiamos estado de QR sin más contexto, la marcamos como inactive localmente.
    this.sessionQrStatus.set(sessionId, "inactive");
  }

  /**
   * 🔁 Calcula delay para reconexión (backoff exponencial con límite)
   */
  computeReconnectDelay(attempt) {
    const base = this.RECONNECT_BASE_DELAY;
    const max = this.RECONNECT_MAX_DELAY;
    const delay = Math.min(base * Math.pow(2, attempt - 1), max);
    return delay + Math.floor(Math.random() * 1000); // un poco de jitter
  }

  /**
   * 🧹 Limpia estado de reconexión
   */
  clearReconnectState(sessionId) {
    const state = this.reconnectState.get(sessionId);
    if (state?.timeoutId) {
      clearTimeout(state.timeoutId);
    }
    this.reconnectState.delete(sessionId);
  }

  /**
   * 🔄 Programa un reintento de conexión con backoff
   */
  scheduleReconnect(sessionId, userId) {
    let state = this.reconnectState.get(sessionId) || {
      attempts: 0,
      timeoutId: null,
    };

    // Si ya hay un timeout programado, no duplicar
    if (state.timeoutId) {
      this.logger.info("⏳ Reintento de conexión ya programado", {
        sessionId,
        attempts: state.attempts,
      });
      return;
    }

    if (state.attempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.warn(
        "⛔ Máximos reintentos de conexión alcanzados, se detiene",
        {
          sessionId,
          attempts: state.attempts,
        }
      );
      return;
    }    

    const attempt = state.attempts + 1;
    const delay = this.computeReconnectDelay(attempt);

    this.logger.info("⏳ Programando reintento de conexión", {
      sessionId,
      attempt,
      delay,
    });

    const timeoutId = setTimeout(async () => {
      // Actualizar estado: este timeout ya se disparó
      this.reconnectState.set(sessionId, { attempts: attempt, timeoutId: null });

      try {
        await this.startSession(sessionId, userId);
      } catch (err) {
        this.logger.error("❌ Error en reintento de conexión", err, {
          sessionId,
          attempt,
        });
        // Re-programar otro intento si no se superó el máximo
        this.scheduleReconnect(sessionId, userId);
      }
    }, delay);

    this.reconnectState.set(sessionId, { attempts: attempt, timeoutId });
  }

  startPendingTimeout(sessionId) {
  // Cancelar si ya existe
  if (this.pendingTimeouts.has(sessionId)) {
    clearTimeout(this.pendingTimeouts.get(sessionId));
  }

  const timeoutId = setTimeout(async () => {
    this.logger.warn("⏰ Sesión en pending expiró, eliminando...", { sessionId });

    try {
      await this.deleteSession(sessionId); // elimina credenciales + socket + QR + reconexión
      await this.postLaravel("/whatsapp/status", {
        session_id: sessionId,
        estado_qr: "inactive",
      });
    } catch (err) {
      this.logger.error("❌ Error eliminando sesión pending", err, { sessionId });
    }

    this.pendingTimeouts.delete(sessionId);
  }, this.PENDING_TIMEOUT_MS);

  this.pendingTimeouts.set(sessionId, timeoutId);
}
clearPendingTimeout(sessionId) {
  if (this.pendingTimeouts.has(sessionId)) {
    clearTimeout(this.pendingTimeouts.get(sessionId));
    this.pendingTimeouts.delete(sessionId);
  }
}


  /**
   * ✅ Sesión abierta
   */
  async handleSessionOpen(sessionId) {
    this.logger.info("✅ Sesión abierta", { sessionId });

    // Limpiar estado de QR y reconexión
    this.clearQrState(sessionId);
    this.clearReconnectState(sessionId);

    // Actualizar estado en Laravel a "active"
    if (await this.isSessionActive(sessionId)) {
      try {
        await this.postLaravel("/whatsapp/status", {
          session_id: sessionId,
          estado_qr: "active",
        });
        this.sessionQrStatus.set(sessionId, "active");

        this.logger.info("✅ Estado actualizado a active", { sessionId });
      } catch (err) {
        this.logger.error("❌ Error actualizando estado a active", err, {
          sessionId,
        });
      }
    }
  }

  /**
   * 🔌 Sesión cerrada
   */
  async handleSessionClose(sessionId, userId, lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    this.logger.info("🔌 Sesión cerrada", { sessionId, statusCode, loggedOut });

    // Limpiar estado de QR (siempre)
    this.clearQrState(sessionId);

    if (loggedOut) {
      // Usuario desconectado → marcar inactive y limpiar
      try {
        await this.postLaravel("/whatsapp/status", {
          session_id: sessionId,
          estado_qr: "inactive",
        });
        this.sessionQrStatus.set(sessionId, "inactive");

        this.logger.info("✅ Estado actualizado a inactive", { sessionId });
      } catch (err) {
        this.logger.error("❌ Error actualizando estado a inactive", err, {
          sessionId,
        });
      }

      // Limpiar de memoria
      delete this.sessions[sessionId];
      this.clearReconnectState(sessionId);
    } else {
      // Reintentar solo si aún está activa en memoria
      const active = await this.isSessionActive(sessionId);

      if (active) {
        this.scheduleReconnect(sessionId, userId);
      } else {
        this.logger.warn("⚠️ SessionId inactivo, no se reintenta conexión", {
          sessionId,
        });
      }
    }
  }

  /**
   * 🚀 Inicia una sesión de WhatsApp
   */
  async startSession(sessionId, userId) {
    try {
      this.logger.info("🚀 Iniciando sesión", { sessionId, userId });

      // Crear directorio de sesión
      const sessionDir = path.join(this.authDir, sessionId);

      if (!fs.existsSync(sessionDir)) {
        this.logger.info("📁 Creando directorio de sesión", { sessionDir });
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      // Cargar credenciales MultiFile
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

      // Usar versión cacheada de Baileys
      const version = await this.getBaileysVersionCached();

      // Crear socket WhatsApp
      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["boty-SaaS", "Chrome", "1.0"],
        printQRInTerminal: false,
      });

      // 📡 Event: actualización de conexión
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

      // 📩 Event: mensajes entrantes
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

      // 🔄 Event: actualización de credenciales
      sock.ev.on("creds.update", saveCreds);

      // Guardar socket en memoria
      this.sessions[sessionId] = sock;

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

          await this.startSession(account.session_id, account.user_id);
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
      if (this.sessions[sessionId]) {
        const sock = this.sessions[sessionId];
        try {
          sock.end();
        } catch (e) {
          // ignorar errores al cerrar el socket
        }
        delete this.sessions[sessionId];
      }

      // Limpiar estado de QR + reconexión
      this.clearQrState(sessionId);
      this.clearReconnectState(sessionId);

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
   * 📊 Información de una sesión
   */
  getSessionInfo(sessionId) {
    const sock = this.sessions[sessionId];

    return {
      exists: !!sock,
      connected: sock?.user ? true : false,
      user: sock?.user || null,
      sessionId,
    };
  }

  /**
   * 📋 Lista sesiones activas en memoria
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
