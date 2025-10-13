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
  constructor(axios, laravelApi, logger, queueManager) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.queueManager = queueManager;

    // Almacenamiento de sesiones activas
    this.sessions = {};

    // Control de QR
    this.qrTimeouts = {};
    this.lastQrSent = new Map();
    this.lastQrAt = new Map();
    this.inflightQr = new Map();

    // Configuraciones
    this.QR_THROTTLE_MS = 30000; // 30 segundos
    this.QR_EXPIRES_MS = 60000; // 60 segundos
    this.MAX_QR_RETRIES = 3;
    this.BACKOFF_BASE = 600;
    this.BACKOFF_JITTER = 400;

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

        if (!retriable || tryNum >= attempts) {
          throw e;
        }

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
   * 🔍 Obtiene el estado del QR en Laravel
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
   * ✅ Verifica si una sesión está activa en Laravel
   */
  async isSessionActive(sessionId) {
    try {
      const estado = await this.getQrStatus(sessionId);
      return !!estado;
    } catch (err) {
      this.logger.error("❌ Error verificando sessionId en Laravel", err, {
        sessionId,
      });
      return false;
    }
  }

  /**
   * 📲 Maneja la generación y envío de QR codes
   */
  async handleQrCode(qr, sessionId, connection) {
    if (!qr || connection === "open") return;

    const active = await this.isSessionActive(sessionId);
    if (!active) {
      this.logger.warn("⚠️ SessionId inactivo, ignorando QR", { sessionId });
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

        await this.postLaravel("/qr", {
          session_id: sessionId,
          qr,
        });

        await this.postLaravel("/whatsapp/status", {
          session_id: sessionId,
          estado_qr: "pending",
        });

        // Marcar como enviado
        this.lastQrSent.set(sessionId, qr);
        this.lastQrAt.set(sessionId, now);

        this.logger.info("✅ QR enviado y estado actualizado", { sessionId });

        // Configurar expiración del QR
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
   * ⏰ Configura la expiración del QR
   */
  setupQrExpiration(sessionId) {
    // Limpiar timeout anterior si existe
    if (this.qrTimeouts[sessionId]) {
      clearTimeout(this.qrTimeouts[sessionId]);
    }

    this.qrTimeouts[sessionId] = setTimeout(async () => {
      try {
        const estado = await this.getQrStatus(sessionId);

        if (estado === "pending") {
          await this.postLaravel("/whatsapp/status", {
            session_id: sessionId,
            estado_qr: "inactive",
          });
          this.logger.info("⏰ QR expirado", { sessionId });
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
  }

  /**
   * ✅ Maneja la sesión abierta
   */
  async handleSessionOpen(sessionId) {
    this.logger.info("✅ Sesión abierta", { sessionId });

    // Limpiar estado de QR
    this.clearQrState(sessionId);

    // Actualizar estado en Laravel
    if (await this.isSessionActive(sessionId)) {
      try {
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
  }

  /**
   * 🔌 Maneja el cierre de sesión
   */
  async handleSessionClose(sessionId, userId, lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    this.logger.info("🔌 Sesión cerrada", { sessionId, statusCode, loggedOut });

    // Limpiar estado de QR
    this.clearQrState(sessionId);

    if (loggedOut) {
      // Usuario desconectado → marcar inactive
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
      delete this.sessions[sessionId];
    } else {
      // Reintentar solo si la sesión sigue activa en Laravel
      const active = await this.isSessionActive(sessionId);

      if (active) {
        this.logger.info("🔄 Reintentando conexión", { sessionId });
        await this.startSession(sessionId, userId);
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

      // Cargar credenciales
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      // Crear socket WhatsApp
      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["boty-SaaS", "Chrome", "1.0"],
        printQRInTerminal: false,
      });

      // 📡 Event: Actualización de conexión
      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        this.logger.info("📡 Actualización de conexión", {
          connection,
          sessionId,
        });

        // Manejar QR
        if (qr) {
          await this.handleQrCode(qr, sessionId, connection);
        }

        // Sesión abierta
        if (connection === "open") {
          await this.handleSessionOpen(sessionId);
        }

        // Sesión cerrada
        if (connection === "close") {
          await this.handleSessionClose(sessionId, userId, lastDisconnect);
        }
      });

      // 📩 Event: Mensajes entrantes
      sock.ev.on("messages.upsert", async (msgUpdate) => {
        try {
          // Agregar a la cola
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
        sock.end();
        delete this.sessions[sessionId];
      }

      // Limpiar estado de QR
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
    const sock = this.sessions[sessionId];

    return {
      exists: !!sock,
      connected: sock?.user ? true : false,
      user: sock?.user || null,
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
