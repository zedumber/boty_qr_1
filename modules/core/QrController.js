class QrController {

  constructor(logger, laravelSync, sessionStore) {
    this.logger = logger;
    this.sync = laravelSync;
    this.sessions = sessionStore;

    this.lastSent = new Map();
    this.lastAt = new Map();
    this.qrTimeouts = {};
    this.pending = new Map();

    this.THROTTLE = 30000;
    this.QR_EXPIRES = 60000;
    this.PENDING_TIMEOUT = 45000;
  }

  clear(sessionId) {
    if (this.qrTimeouts[sessionId]) clearTimeout(this.qrTimeouts[sessionId]);
    delete this.qrTimeouts[sessionId];

    if (this.pending.has(sessionId)) {
      clearTimeout(this.pending.get(sessionId));
      this.pending.delete(sessionId);
    }
  }

  setupExpiration(sessionId) {
    if (this.qrTimeouts[sessionId]) clearTimeout(this.qrTimeouts[sessionId]);

    this.qrTimeouts[sessionId] = setTimeout(() => {
      this.logger.info("⏰ QR expirado", { sessionId });
      this.sync.enqueue({ path: "/whatsapp/status", payload: { session_id: sessionId, estado_qr: "inactive" } });
      delete this.qrTimeouts[sessionId];
    }, this.QR_EXPIRES);
  }

  startPendingTimeout(sessionId) {
    if (this.pending.has(sessionId))
      clearTimeout(this.pending.get(sessionId));

    const timeout = setTimeout(() => {
      this.logger.warn("⏰ pending vencido → eliminando sesión", { sessionId });
      this.sessions.delete(sessionId);

      this.sync.enqueue({
        path: "/whatsapp/status",
        payload: { session_id: sessionId, estado_qr: "inactive" }
      });

      this.pending.delete(sessionId);
    }, this.PENDING_TIMEOUT);

    this.pending.set(sessionId, timeout);
  }

  async handle(qr, sessionId, connection) {
    if (!qr || connection === "open") return;

    if (!this.sessions.has(sessionId)) return;

    const prev = this.lastSent.get(sessionId);
    const last = this.lastAt.get(sessionId) || 0;
    const now = Date.now();

    const newQr = qr !== prev;
    const canSend = now - last >= this.THROTTLE;

    if (!newQr || !canSend) return;

    this.logger.info("📲 Nuevo QR", { sessionId });

    this.sync.enqueue({ path: "/qr", payload: { session_id: sessionId, qr } });
    this.sync.enqueue({ path: "/whatsapp/status", payload: { session_id: sessionId, estado_qr: "pending" } });

    this.startPendingTimeout(sessionId);
    this.setupExpiration(sessionId);

    this.lastSent.set(sessionId, qr);
    this.lastAt.set(sessionId, now);
  }
}

module.exports = QrController;
