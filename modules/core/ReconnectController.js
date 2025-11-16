class ReconnectController {
  constructor(logger, startFn) {
    this.logger = logger;
    this.startFn = startFn;

    this.reconnectState = new Map();
    this.MAX_RETRIES = 5;
    this.BASE = 5000;
    this.MAX = 60000;
  }

  compute(attempt) {
    return Math.min(this.BASE * Math.pow(2, attempt - 1), this.MAX) + Math.floor(Math.random() * 1000);
  }

  clear(sessionId) {
    const st = this.reconnectState.get(sessionId);
    if (st?.timeout) clearTimeout(st.timeout);
    this.reconnectState.delete(sessionId);
  }

  schedule(sessionId, userId) {
    let st = this.reconnectState.get(sessionId) || { tries: 0, timeout: null };

    if (st.timeout) return;
    if (st.tries >= this.MAX_RETRIES) {
      this.logger.warn("⛔ Max reconexión alcanzado", { sessionId });
      return;
    }

    const attempt = st.tries + 1;
    const delay = this.compute(attempt);

    this.logger.info("⏳ Reintentando conexión", { sessionId, attempt, delay });

    st.timeout = setTimeout(async () => {
      st.tries = attempt;
      st.timeout = null;

      try {
        await this.startFn(sessionId, userId);
      } catch (e) {
        this.logger.error("❌ Error reintentando", { sessionId, attempt });
        this.schedule(sessionId, userId);
      }
    }, delay);

    this.reconnectState.set(sessionId, st);
  }
}

module.exports = ReconnectController;
