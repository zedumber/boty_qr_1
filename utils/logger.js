/**
 * 📝 Sistema de Logger estructurado
 */

class Logger {
  constructor() {
    this.serviceName = "whatsapp-service";
  }

  /**
   * ℹ️ Log de información
   */
  info(message, meta = {}) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "INFO",
        service: this.serviceName,
        message,
        ...meta,
      })
    );
  }

  /**
   * ⚠️ Log de advertencia
   */
  warn(message, meta = {}) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "WARN",
        service: this.serviceName,
        message,
        ...meta,
      })
    );
  }

  /**
   * ❌ Log de error
   */
  error(message, error = null, meta = {}) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        service: this.serviceName,
        message,
        error: error ? error.message : null,
        stack: error ? error.stack : null,
        ...meta,
      })
    );
  }

  /**
   * 🐛 Log de debug (solo en desarrollo)
   */
  debug(message, meta = {}) {
    if (process.env.NODE_ENV === "development") {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "DEBUG",
          service: this.serviceName,
          message,
          ...meta,
        })
      );
    }
  }
}

module.exports = new Logger();
