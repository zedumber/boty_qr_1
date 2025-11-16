const fs = require("fs");
const path = require("path");
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");

class SessionStore {
  constructor(logger) {
    this.logger = logger;
    this.sessions = {};
    this.authDir = path.join(__dirname, "..", "..", "auth");
  }

  getSocket(sessionId) {
    return this.sessions[sessionId] || null;
  }

  has(sessionId) {
    return !!this.sessions[sessionId];
  }

  save(sessionId, sock) {
    this.sessions[sessionId] = sock;
  }

  delete(sessionId) {
    if (this.sessions[sessionId]) {
      try {
        this.sessions[sessionId].end();
      } catch (_) {}
      delete this.sessions[sessionId];
    }

    const dir = path.join(this.authDir, sessionId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    this.logger.info("🗑️ Sesión eliminada", { sessionId });
  }

  async loadAuth(sessionId) {
    const dir = path.join(this.authDir, sessionId);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    return await useMultiFileAuthState(dir);
  }
}

module.exports = SessionStore;
