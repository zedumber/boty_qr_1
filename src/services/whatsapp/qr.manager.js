// src/services/whatsapp/qr.manager.js

/**
 * 📲 Gestor de Códigos QR
 *
 * Responsabilidad:
 * - Generar y enviar códigos QR
 * - Controlar throttle y límite de envíos
 * - Gestionar expiración de QR
 */

class QRManager {
  constructor(cacheManager, batchQueueManager, stateManager, logger) {
    this.cacheManager = cacheManager;
    this.batchQueueManager = batchQueueManager;
    this.stateManager = stateManager;
    this.logger = logger;

    // Contador de QR enviados por sesión
    this.qrSendCount = new Map(); // sessionId → count

    // Estado de QR
    this.qrTimeouts = {}; // sessionId → timeoutId
    this.lastQrSent = new Map(); // sessionId → qr string
    this.lastQrAt = new Map(); // sessionId → timestamp ms
    this.inflightQr = new Map(); // sessionId → bool

    // Configuración
    this.QR_THROTTLE_MS = 5000; // 5s entre QR
    this.QR_EXPIRES_MS = 60000; // 60s vida QR
    this.MAX_QR_RETRIES = 4;
  }

  /**
   * 📲 Genera y envía un nuevo código QR
   */
  async handleQrCode(qr, sessionId, connection) {
    if (!qr) return;

    // ❌ No procesar QR si la sesión está cerrando
    if (connection === "close") {
      this.logger.debug("ℹ️ Ignorando QR porque la sesión está cerrando", {
        sessionId,
        connection,
      });
      return;
    }

    if (!this.qrSendCount.has(sessionId)) {
      this.qrSendCount.set(sessionId, 0);
    }

    const currentCount = this.qrSendCount.get(sessionId);

    if (currentCount >= this.MAX_QR_RETRIES) {
      this.logger.warn("⚠️ Límite de QR alcanzado", { sessionId });
      return;
    }

    const isNewQr = await this.cacheManager.isNewQr(sessionId, qr);
    if (!isNewQr) {
      return;
    }

    if (this.inflightQr.get(sessionId)) return;

    this.inflightQr.set(sessionId, true);

    try {
      this.logger.info("📲 Nuevo QR generado", { sessionId });

      await this.cacheManager.setQr(sessionId, qr);

      this.batchQueueManager.addQr(sessionId, qr);
      await this.stateManager.updateSessionStatus(
        sessionId,
        "pending",
        "normal"
      );

      this.lastQrSent.set(sessionId, qr);
      this.lastQrAt.set(sessionId, Date.now());
      this.qrSendCount.set(sessionId, currentCount + 1);

      this.setupQrExpiration(sessionId);
    } finally {
      this.inflightQr.set(sessionId, false);
    }
  }

  /**
   * ⏰ Configura expiración automática de QR
   */
  setupQrExpiration(sessionId) {
    if (this.qrTimeouts[sessionId]) {
      clearTimeout(this.qrTimeouts[sessionId]);
    }

    this.qrTimeouts[sessionId] = setTimeout(async () => {
      try {
        const estado = await this.cacheManager.getStatus(sessionId);

        if (estado === "pending") {
          await this.stateManager.updateSessionStatus(
            sessionId,
            "inactive",
            "normal"
          );

          this.clearQrState(sessionId);
          this.qrSendCount.set(sessionId, 0);

          this.logger.info("⏰ QR expirado → estado reseteado", { sessionId });
        }
      } catch (err) {
        this.logger.error("❌ Error al expirar QR", err, { sessionId });
      } finally {
        delete this.qrTimeouts[sessionId];
      }
    }, this.QR_EXPIRES_MS);
  }

  /**
   * 🧹 Limpia estado de QR
   */
  clearQrState(sessionId) {
    if (this.qrTimeouts[sessionId]) {
      clearTimeout(this.qrTimeouts[sessionId]);
      delete this.qrTimeouts[sessionId];
    }

    this.lastQrSent.delete(sessionId);
    this.lastQrAt.delete(sessionId);
    this.inflightQr.delete(sessionId);
    this.qrSendCount.set(sessionId, 0);
  }

  /**
   * 🔄 Resetea contador de QR
   */
  resetQrCount(sessionId) {
    this.qrSendCount.set(sessionId, 0);
  }
}

module.exports = QRManager;
