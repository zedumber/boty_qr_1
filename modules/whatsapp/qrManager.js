/**
 * 📲 QR Manager
 * Gestiona QR codes de manera escalable
 * Responsabilidades:
 * - Throttling de envíos de QR
 * - Deduplicación de QR
 * - Expiración automática de QR
 * - Control de reintentos
 * - Sincronización con Laravel
 */

class QRManager {
  constructor(axios, laravelApi, logger, config = {}) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;

    // Configuración de QR
    this.QR_THROTTLE_MS = config.qrThrottleMs || 30000; // 30 segundos
    this.QR_EXPIRES_MS = config.qrExpiresMs || 60000; // 60 segundos
    this.MAX_QR_RETRIES = config.maxQrRetries || 3;
    this.BACKOFF_BASE = config.backoffBase || 600;
    this.BACKOFF_JITTER = config.backoffJitter || 400;

    // Control de QR por sesión
    this.qrTimeouts = {}; // { sessionId: timeoutId }
    this.lastQrSent = new Map(); // { sessionId: qrCode }
    this.lastQrAt = new Map(); // { sessionId: timestamp }
    this.inflightQr = new Map(); // { sessionId: boolean }
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
        return await this.axios.post(`${this.laravelApi}${path}`, body);
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
   * Con throttling, deduplicación y control de reintentos
   */
  async handleQrCode(qr, sessionId, connectionStatus) {
    if (!qr || connectionStatus === "open") return;

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
    // No hay envío en curso
    const notInflight = !this.inflightQr.get(sessionId);

    if (isNewQr && canSend && notInflight) {
      this.inflightQr.set(sessionId, true);

      try {
        this.logger.info("📲 Nuevo QR generado", { sessionId });

        // Enviar QR
        await this.postLaravel("/qr", {
          session_id: sessionId,
          qr,
        });

        // Actualizar estado
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
   * 📊 Obtiene estadísticas de QR
   */
  getQRStats() {
    return {
      pendingQR: Array.from(this.inflightQr.values()).filter((v) => v).length,
      trackedSessions: this.lastQrSent.size,
    };
  }
}

module.exports = QRManager;
