/**
 * 📦 Módulo de Batch Queue
 *
 * Agrupa peticiones a Laravel para reducir carga:
 * - Batching de QR codes
 * - Batching de status updates
 * - Deduplicación automática
 * - Flush periódico o por tamaño
 */

class BatchQueueManager {
  constructor(axios, laravelApi, logger, config) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;

    // Configuración
    this.batchSize = config.batchSize || 50;
    this.batchInterval = config.batchInterval || 5000; // 5 segundos
    this.priorityInterval = config.priorityInterval || 1000; // 1 segundo para high priority
    this.lifecycleEndpoint = config?.lifecycle?.batchEndpoint || null;
    this.lifecycleBatchInterval =
      config?.lifecycle?.batchInterval || this.batchInterval;

    // Colas de batch
    this.qrBatch = new Map(); // sessionId -> {qr, timestamp}
    this.statusBatch = new Map(); // sessionId -> {status, priority, timestamp}
    this.lifecycleBatch = []; // {session_id, event, meta, timestamp}

    // Timestamps
    this.lastFlushQr = 0;
    this.lastFlushStatus = 0;
    this.lastFlushLifecycle = 0;

    // Iniciar procesador de batches
    this.startBatchProcessor();
  }

  /**
   * ➕ Agrega un QR al batch
   */
  addQr(sessionId, qr) {
    this.qrBatch.set(sessionId, {
      qr,
      timestamp: Date.now(),
    });

    this.logger.debug("📦 QR añadido a batch", {
      sessionId,
      batchSize: this.qrBatch.size,
    });

    // Flush si alcanza tamaño
    if (this.qrBatch.size >= this.batchSize) {
      this.flushQrBatch();
    }
  }

  /**
   * ➕ Agrega un status update al batch
   */
  addStatus(sessionId, status, priority = "normal") {
    this.statusBatch.set(sessionId, {
      status,
      priority, // "high" o "normal"
      timestamp: Date.now(),
    });

    this.logger.debug("📦 Status añadido a batch", {
      sessionId,
      status,
      priority,
      batchSize: this.statusBatch.size,
    });

    // Flush inmediato si es high priority
    if (priority === "high") {
      this.flushStatusBatch(true);
    }
  }

  /**
   * 🧭 Agrega eventos de ciclo de vida
   */
  addLifecycleEvent(sessionId, event, meta = {}, priority = "normal") {
    if (!this.lifecycleEndpoint) {
      return;
    }

    this.lifecycleBatch.push({
      session_id: sessionId,
      event,
      meta,
      priority,
      timestamp: Date.now(),
    });

    if (this.lifecycleBatch.length >= this.batchSize) {
      this.flushLifecycleBatch(true).catch((err) =>
        this.logger.error("❌ Error forzando lifecycle batch", err)
      );
    }
  }

  /**
   * 🚀 Envía batch de QR codes a Laravel
   */
  async flushQrBatch() {
    if (this.qrBatch.size === 0) return;

    const now = Date.now();

    // Protección: no enviar si se hizo hace poco
    if (now - this.lastFlushQr < 1000) {
      return;
    }

    const batch = Array.from(this.qrBatch.entries()).map(
      ([sessionId, data]) => ({
        session_id: sessionId,
        qr: data.qr,
      })
    );

    this.qrBatch.clear();
    this.lastFlushQr = now;

    try {
      this.logger.info("📤 Enviando batch de QR", {
        count: batch.length,
        endpoint: "/qr/batch",
      });

      const response = await this.axios.post(`${this.laravelApi}/qr/batch`, {
        qrs: batch,
      });

      this.logger.info("✅ Batch de QR enviado exitosamente", {
        count: batch.length,
        statusCode: response.status,
      });

      return response.data;
    } catch (error) {
      this.logger.error("❌ Error enviando batch de QR", error, {
        count: batch.length,
        status: error?.response?.status,
      });

      // Re-agregar al batch para reintentar
      batch.forEach((item) => {
        this.addQr(item.session_id, item.qr);
      });

      throw error;
    }
  }

  /**
   * 🚀 Envía batch de status updates a Laravel
   */
  async flushStatusBatch(isHighPriority = false) {
    if (this.statusBatch.size === 0) return;

    const now = Date.now();
    const minInterval = isHighPriority ? 500 : this.priorityInterval;

    // Protección: no enviar si se hizo hace poco
    if (now - this.lastFlushStatus < minInterval) {
      return;
    }

    // Separar por prioridad
    const highPriority = [];
    const normalPriority = [];

    this.statusBatch.forEach((data, sessionId) => {
      const item = {
        session_id: sessionId,
        estado_qr: data.status,
      };

      if (data.priority === "high") {
        highPriority.push(item);
      } else {
        normalPriority.push(item);
      }
    });

    // Enviar high priority primero
    const batch = [...highPriority, ...normalPriority];

    this.statusBatch.clear();
    this.lastFlushStatus = now;

    try {
      this.logger.info("📤 Enviando batch de status", {
        count: batch.length,
        highPriority: highPriority.length,
        endpoint: "/whatsapp/status/batch",
      });

      const response = await this.axios.post(
        `${this.laravelApi}/whatsapp/status/batch`,
        {
          statuses: batch,
        }
      );

      this.logger.info("✅ Batch de status enviado exitosamente", {
        count: batch.length,
        statusCode: response.status,
      });

      return response.data;
    } catch (error) {
      this.logger.error("❌ Error enviando batch de status", error, {
        count: batch.length,
        status: error?.response?.status,
      });

      // Re-agregar al batch para reintentar
      batch.forEach((item) => {
        this.addStatus(
          item.session_id,
          item.estado_qr,
          highPriority.includes(item) ? "high" : "normal"
        );
      });

      throw error;
    }
  }

  /**
   * 🚀 Envía batch de eventos de ciclo de vida
   */
  async flushLifecycleBatch(force = false) {
    if (!this.lifecycleEndpoint || this.lifecycleBatch.length === 0) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastFlushLifecycle < this.lifecycleBatchInterval) {
      return;
    }

    const batch = [...this.lifecycleBatch];
    this.lifecycleBatch = [];
    this.lastFlushLifecycle = now;

    try {
      this.logger.info("📤 Enviando batch de lifecycle", {
        count: batch.length,
        endpoint: this.lifecycleEndpoint,
      });

      const response = await this.axios.post(
        `${this.laravelApi}${this.lifecycleEndpoint}`,
        {
          events: batch,
        }
      );

      this.logger.info("✅ Batch de lifecycle enviado", {
        count: batch.length,
        statusCode: response.status,
      });
    } catch (error) {
      this.logger.error("❌ Error enviando batch de lifecycle", error, {
        count: batch.length,
        endpoint: this.lifecycleEndpoint,
      });

      this.lifecycleBatch.unshift(...batch);
      throw error;
    }
  }

  /**
   * ⏰ Inicia el procesador automático de batches
   */
  startBatchProcessor() {
    // Procesar QR batch cada 5 segundos
    this.qrInterval = setInterval(() => {
      if (this.qrBatch.size > 0) {
        this.flushQrBatch().catch((err) => {
          this.logger.error("❌ Error en intervalo QR batch", err);
        });
      }
    }, this.batchInterval);

    // Procesar status batch cada 1 segundo
    this.statusInterval = setInterval(() => {
      if (this.statusBatch.size > 0) {
        this.flushStatusBatch(false).catch((err) => {
          this.logger.error("❌ Error en intervalo status batch", err);
        });
      }
    }, this.priorityInterval);

    if (this.lifecycleEndpoint) {
      this.lifecycleInterval = setInterval(() => {
        if (this.lifecycleBatch.length > 0) {
          this.flushLifecycleBatch(false).catch((err) => {
            this.logger.error("❌ Error en intervalo lifecycle batch", err);
          });
        }
      }, this.lifecycleBatchInterval);
    }

    this.logger.info("⏰ Batch processor iniciado", {
      qrInterval: this.batchInterval,
      statusInterval: this.priorityInterval,
      lifecycleInterval: this.lifecycleEndpoint
        ? this.lifecycleBatchInterval
        : 0,
    });
  }

  /**
   * 🛑 Detiene el procesador
   */
  stopBatchProcessor() {
    if (this.qrInterval) clearInterval(this.qrInterval);
    if (this.statusInterval) clearInterval(this.statusInterval);
    if (this.lifecycleInterval) clearInterval(this.lifecycleInterval);
    this.logger.info("🛑 Batch processor detenido");
  }

  /**
   * 🔄 Flush forzado de todos los batches
   */
  async flushAll() {
    try {
      await Promise.all([
        this.flushQrBatch(),
        this.flushStatusBatch(true),
        this.flushLifecycleBatch(true),
      ]);
      this.logger.info("✅ Todos los batches flushed");
    } catch (error) {
      this.logger.error("❌ Error en flush all", error);
    }
  }

  /**
   * 📊 Obtiene métricas del batch
   */
  getMetrics() {
    return {
      qrBatchSize: this.qrBatch.size,
      statusBatchSize: this.statusBatch.size,
      lastFlushQr: this.lastFlushQr,
      lastFlushStatus: this.lastFlushStatus,
      timeSinceLastFlushQr: Date.now() - this.lastFlushQr,
      timeSinceLastFlushStatus: Date.now() - this.lastFlushStatus,
    };
  }

  /**
   * 📋 Obtiene contenido actual del batch
   */
  getBatchContent() {
    return {
      qr: Array.from(this.qrBatch.entries()).map(([sessionId, data]) => ({
        sessionId,
        qr: data.qr,
      })),
      status: Array.from(this.statusBatch.entries()).map(
        ([sessionId, data]) => ({
          sessionId,
          status: data.status,
          priority: data.priority,
        })
      ),
    };
  }
}

module.exports = BatchQueueManager;
