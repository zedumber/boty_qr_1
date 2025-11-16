const makeWASocket = require("@whiskeysockets/baileys").default;
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const LaravelSync = require("./core/LaravelSync");
const VersionManager = require("./core/VersionManager");
const SessionStore = require("./core/SessionStore");
const ReconnectController = require("./core/ReconnectController");
const QrController = require("./core/QrController");

class WhatsAppManager {
  constructor(
    axios,
    laravelApi,
    logger,
    queueManager,
    pendingSessionTimeout = 120000
  ) {
    this.logger = logger;
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.queueManager = queueManager;

    // core helpers
    this.sync = new LaravelSync(axios, laravelApi, logger, queueManager);
    this.versions = new VersionManager(logger);
    this.sessions = new SessionStore(logger);

    this.reconnect = new ReconnectController(logger, (sessionId, userId) =>
      this.startSession(sessionId, userId)
    );

    // Pasar timeout de pending (2 minutos)
    this.qr = new QrController(
      logger,
      this.sync,
      this.sessions,
      pendingSessionTimeout
    );
  }

  // Inicia una sesión usando los helpers modulares
  async startSession(sessionId, userId) {
    try {
      this.logger.info("🚀 Iniciando sesión", { sessionId, userId });

      const { state, saveCreds } = await this.sessions.loadAuth(sessionId);

      const version = await this.versions.get();

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: ["Boty", "Chrome", "1.0"],
      });

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ⚠️ NUEVO: Solo generar QR si la sesión está activa en memoria
        if (qr && this.sessions.has(sessionId)) {
          await this.qr.handle(qr, sessionId, connection);
        }

        if (connection === "open") {
          this.qr.clear(sessionId);
          this.reconnect.clear(sessionId);

          // Usar LaravelSync.enqueue() en lugar de postLaravel()
          // Evita reintentos agresivos que abren el Circuit Breaker
          this.sync.enqueue({
            path: "/whatsapp/status",
            payload: { session_id: sessionId, estado_qr: "active" },
          });

          this.logger.info("🔥 Sesión abierta", { sessionId });
        }

        if (connection === "close") {
          this.qr.clear(sessionId);

          const code = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === 401;

          if (loggedOut) {
            try {
              this.sessions.delete(sessionId);
            } catch (e) {
              this.logger.warn("⚠️ Error eliminando sesión en logout", {
                sessionId,
                error: e,
              });
            }

            this.sync.enqueue({
              path: "/whatsapp/status",
              payload: { session_id: sessionId, estado_qr: "inactive" },
            });

            this.logger.warn("🔒 Sesión cerrada (loggedOut)", { sessionId });
          } else {
            this.logger.warn("🔄 Reconexión programada", { sessionId });
            this.reconnect.schedule(sessionId, userId);
          }
        }
      });

      sock.ev.on("messages.upsert", async (msgUpdate) => {
        try {
          await this.queueManager.addMessageToQueue(msgUpdate, sessionId);
        } catch (err) {
          this.logger.error("❌ Error agregando mensaje a cola", err, {
            sessionId,
          });
        }
      });

      sock.ev.on("creds.update", saveCreds);

      this.sessions.save(sessionId, sock);

      this.logger.info("✅ Sesión iniciada correctamente", { sessionId });

      return sock;
    } catch (error) {
      this.logger.error("❌ Error iniciando sesión", { sessionId, error });
      throw error;
    }
  }

  // Restaura sesiones consultando la API de Laravel (accounts activas)
  async restoreSessions() {
    try {
      this.logger.info("🔄 Restaurando sesiones activas...");

      const { data: accounts } = await this.axios.get(
        `${this.laravelApi}/whatsapp/accounts/active`
      );

      if (!accounts || accounts.length === 0) {
        this.logger.info("ℹ️ No hay cuentas activas para restaurar");
        return [];
      }

      for (const account of accounts) {
        try {
          await this.startSession(account.session_id, account.user_id);
          this.logger.info("♻️ Sesión restaurada", {
            sessionId: account.session_id,
          });
        } catch (err) {
          this.logger.error("❌ Error restaurando sesión", {
            accountId: account.id,
            error: err,
          });
        }
      }

      this.logger.info("✅ Proceso de restauración completado");
      return accounts.map((a) => a.session_id);
    } catch (error) {
      this.logger.error("❌ Error restaurando sesiones", error);
      throw error;
    }
  }

  // Cierra todas las sesiones activas
  async closeAllSessions() {
    try {
      this.logger.info("🛑 Cerrando todas las sesiones...");

      const ids = Object.keys(this.sessions.sessions || {});

      for (const id of ids) {
        try {
          const sock = this.sessions.getSocket(id);
          if (sock && typeof sock.end === "function") sock.end();
        } catch (err) {
          this.logger.warn("⚠️ Error cerrando socket", {
            sessionId: id,
            error: err,
          });
        }
        // no eliminar credenciales aquí, solo cerrar conexiones
      }

      // limpiar memoria
      this.sessions.sessions = {};

      this.logger.info("✅ Todas las sesiones cerradas");
    } catch (error) {
      this.logger.error("❌ Error en closeAllSessions", { error });
      throw error;
    }
  }

  // Lista sesiones activas (info)
  listActiveSessions() {
    return Object.keys(this.sessions.sessions || {}).map((id) =>
      this.getSessionInfo(id)
    );
  }

  getSessionInfo(sessionId) {
    const sock = this.sessions.getSocket(sessionId);
    return {
      sessionId,
      exists: !!sock,
      connected: !!(sock && sock.user),
      user: sock?.user || null,
    };
  }

  // Elimina sesión (cierra y borra credenciales)
  async deleteSession(sessionId) {
    try {
      this.logger.info("🗑️ Eliminando sesión", { sessionId });

      if (this.sessions.has(sessionId)) {
        const sock = this.sessions.getSocket(sessionId);
        try {
          if (sock && typeof sock.end === "function") sock.end();
        } catch (_) {}

        // SessionStore.delete limpia archivos y memoria
        this.sessions.delete(sessionId);
      } else {
        // Aun así intentar borrar archivos de auth por si acaso
        const dir = path.join(
          this.sessions.authDir || path.join(__dirname, "..", "auth"),
          sessionId
        );
        if (fs.existsSync(dir))
          fs.rmSync(dir, { recursive: true, force: true });
      }

      // Asegurar limpieza de QR/reconnect si existen
      try {
        this.qr.clear(sessionId);
      } catch (_) {}
      try {
        this.reconnect.clear(sessionId);
      } catch (_) {}

      this.logger.info("✅ Sesión eliminada", { sessionId });
    } catch (error) {
      this.logger.error("❌ Error eliminando sesión", { sessionId, error });
      throw error;
    }
  }
}

module.exports = WhatsAppManager;
