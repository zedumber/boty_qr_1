const makeWASocket = require("@whiskeysockets/baileys").default;
const pino = require("pino");

const LaravelSync = require("./core/LaravelSync");
const VersionManager = require("./core/VersionManager");
const SessionStore = require("./core/SessionStore");
const ReconnectController = require("./core/ReconnectController");
const QrController = require("./core/QrController");

class WhatsAppManager {

  constructor(axios, laravelApi, logger, queueManager) {
    this.logger = logger;

    this.sync = new LaravelSync(axios, laravelApi, logger, queueManager);
    this.versions = new VersionManager(logger);
    this.sessions = new SessionStore(logger);

    this.reconnect = new ReconnectController(
      logger,
      (sessionId, userId) => this.startSession(sessionId, userId)
    );

    this.qr = new QrController(logger, this.sync, this.sessions);
  }

  async startSession(sessionId, userId) {
    try {
      this.logger.info("🚀 Iniciando sesión", { sessionId });

      const { state, saveCreds } = await this.sessions.loadAuth(sessionId);

      const version = await this.versions.get();

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: ["Boty", "Chrome", "1.0"],
      });

      sock.ev.on("connection.update", update => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) this.qr.handle(qr, sessionId, connection);

        if (connection === "open") {
          this.qr.clear(sessionId);
          this.reconnect.clear(sessionId);

          this.sync.enqueue({
            path: "/whatsapp/status",
            payload: { session_id: sessionId, estado_qr: "active" }
          });

          this.logger.info("🔥 Sesión abierta", { sessionId });
        }

        if (connection === "close") {
          this.qr.clear(sessionId);

          const code = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === 401;

          if (loggedOut) {
            this.sessions.delete(sessionId);
            this.sync.enqueue({
              path: "/whatsapp/status",
              payload: { session_id: sessionId, estado_qr: "inactive" }
            });
            this.logger.warn("🔒 Sesión cerrada (loggedOut)", { sessionId });
          } else {
            this.logger.warn("🔄 Reconexión programada", { sessionId });
            this.reconnect.schedule(sessionId, userId);
          }
        }
      });

      sock.ev.on("creds.update", saveCreds);

      this.sessions.save(sessionId, sock);

    } catch (error) {
      this.logger.error("❌ Error iniciando sesión", { sessionId, error });
      throw error;
    }
  }
}

module.exports = WhatsAppManager;
