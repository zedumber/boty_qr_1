// src/services/whatsapp/socket.factory.js

/**
 * 🏭 Factory de Sockets Baileys
 *
 * Responsabilidad:
 * - Crear instancias de socket Baileys configuradas
 * - Vincular event handlers
 * - Cerrar sockets correctamente
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

class SocketFactory {
  constructor(authDir, logger) {
    this.authDir = authDir;
    this.logger = logger;
  }

  /**
   * 🏗️ Crea un socket Baileys configurado
   */
  async createSocket(sessionId) {
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
      browser: ["Chrome", "Windows", "10"],
      printQRInTerminal: false,
      syncFullHistory: false,
    });

    return { sock, state, saveCreds };
  }

  /**
   * 🔗 Vincula event handlers al socket
   */
  attachEventHandlers(sock, handlers) {
    if (handlers.onConnectionUpdate) {
      sock.ev.on("connection.update", handlers.onConnectionUpdate);
    }

    if (handlers.onMessagesUpsert) {
      sock.ev.on("messages.upsert", handlers.onMessagesUpsert);
    }

    if (handlers.onCredsUpdate) {
      sock.ev.on("creds.update", handlers.onCredsUpdate);
    }
  }

  /**
   * 🔌 Cierra un socket correctamente
   */
  async closeSocket(sock) {
    if (!sock) return;

    try {
      await sock.logout();
    } catch (err) {
      this.logger.warn("⚠️ Error en logout (ignorado)", { error: err.message });
    }
  }

  /**
   * 🧹 Elimina directorio de autenticación
   */
  removeAuthDir(sessionId) {
    const sessionDir = path.join(this.authDir, sessionId);

    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      this.logger.info("🗑️ Directorio de auth eliminado", { sessionDir });
    }
  }
}

module.exports = SocketFactory;
