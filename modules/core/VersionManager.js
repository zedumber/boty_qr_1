const { fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");

class VersionManager {
  constructor(logger) {
    this.logger = logger;
    this.cached = null;
    this.promise = null;
  }

  async get() {
    if (this.cached) return this.cached;
    if (this.promise) return this.promise;

    this.promise = (async () => {
      const { version } = await fetchLatestBaileysVersion();
      this.cached = version;
      this.promise = null;

      this.logger.info("ℹ️ Baileys version cacheada", { version });
      return version;
    })();

    return this.promise;
  }
}

module.exports = VersionManager;
