/**
 * 📊 Módulo de Gestión de Colas
 *
 * Gestiona:
 * - Colas de Bull/Redis para mensajes
 * - Circuit Breaker para protección de servicios
 * - Métricas de rendimiento
 * - Procesamiento concurrente de mensajes
 */

const Queue = require("bull");
const Redis = require("ioredis");

/**
 * 🔌 Circuit Breaker Pattern
 * Protege servicios externos de sobrecarga
 */
class CircuitBreaker {
  constructor(failureThreshold = 5, resetTimeout = 60000) {
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = "CLOSED"; // CLOSED, OPEN, HALF_OPEN
  }

  async execute(callback) {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = "HALF_OPEN";
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    }

    try {
      const result = await callback();

      if (this.state === "HALF_OPEN") {
        this.state = "CLOSED";
        this.failureCount = 0;
      }

      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.failureThreshold) {
        this.state = "OPEN";
      }

      throw error;
    }
  }

  getStatus() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

/**
 * 📈 Sistema de Métricas de Rendimiento
 */
class PerformanceMetrics {
  constructor(logger) {
    this.logger = logger;
    this.messagesProcessed = 0;
    this.messagesFailed = 0;
    this.avgProcessingTime = 0;
    this.startTimes = new Map();
    this.logInterval = 100; // Loggear cada 100 mensajes
  }

  startMessage(id) {
    this.startTimes.set(id, Date.now());
  }

  async endMessage(id, success = true, queue = null) {
    const startTime = this.startTimes.get(id);
    if (!startTime) return;

    const processingTime = Date.now() - startTime;

    // Calcular promedio móvil
    this.avgProcessingTime =
      (this.avgProcessingTime * this.messagesProcessed + processingTime) /
      (this.messagesProcessed + 1);

    if (success) {
      this.messagesProcessed++;
    } else {
      this.messagesFailed++;
    }

    this.startTimes.delete(id);

    // Loggear métricas periódicamente
    if (this.messagesProcessed % this.logInterval === 0) {
      await this.logMetrics(queue);
    }
  }

  async logMetrics(queue = null) {
    try {
      const metrics = {
        messagesProcessed: this.messagesProcessed,
        messagesFailed: this.messagesFailed,
        avgProcessingTime: Math.round(this.avgProcessingTime),
        successRate:
          this.messagesProcessed > 0
            ? (
                (this.messagesProcessed /
                  (this.messagesProcessed + this.messagesFailed)) *
                100
              ).toFixed(2) + "%"
            : "0%",
      };

      if (queue) {
        const counts = await queue.getJobCounts();
        metrics.queueCounts = counts;
      }

      this.logger.info("📊 Métricas de rendimiento", metrics);
    } catch (err) {
      this.logger.error("❌ Error obteniendo métricas", err);
    }
  }

  getMetrics() {
    return {
      messagesProcessed: this.messagesProcessed,
      messagesFailed: this.messagesFailed,
      avgProcessingTime: this.avgProcessingTime,
      pendingMessages: this.startTimes.size,
    };
  }

  reset() {
    this.messagesProcessed = 0;
    this.messagesFailed = 0;
    this.avgProcessingTime = 0;
    this.startTimes.clear();
  }
}

/**
 * 🎯 Gestor de Colas Principal
 */
class QueueManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.redisConfig = {
      host: config.redisHost || "localhost",
      port: config.redisPort || 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };

    // Instancias
    this.messageQueue = null;
    this.qrQueue = null;
    this.redisClient = null;
    this.circuitBreaker = new CircuitBreaker(5, 60000);
    this.metrics = new PerformanceMetrics(logger);

    // Configuraciones
    this.maxConcurrentMessages = config.maxConcurrentMessages || 5;
    this.messageProcessingTimeout = config.messageProcessingTimeout || 30000;
  }

  /**
   * 🚀 Inicializa las colas y conexiones
   */
  async initialize() {
    try {
      this.logger.info("🔄 Inicializando sistema de colas...", {
        redisHost: this.redisConfig.host,
        redisPort: this.redisConfig.port,
      });

      // Crear cliente Redis
      this.redisClient = new Redis(this.redisConfig);

      this.redisClient.on("connect", () => {
        this.logger.info("✅ Conectado a Redis");
      });

      this.redisClient.on("error", (err) => {
        this.logger.error("❌ Error de conexión a Redis", err);
      });

      // Crear colas
      this.messageQueue = new Queue("whatsapp-messages", {
        redis: this.redisConfig,
      });

      this.qrQueue = new Queue("qr-processing", {
        redis: this.redisConfig,
      });

      // Configurar event listeners
      this.setupQueueEvents();

      this.logger.info("✅ Sistema de colas inicializado correctamente");
    } catch (error) {
      this.logger.error("❌ Error inicializando colas", error);
      throw error;
    }
  }

  /**
   * 🎧 Configura event listeners para las colas
   */
  setupQueueEvents() {
    // Eventos de mensajes
    this.messageQueue.on("completed", (job) => {
      this.logger.info("✅ Job completado", { jobId: job.id });
    });

    this.messageQueue.on("failed", (job, err) => {
      this.logger.error("❌ Job falló", err, { jobId: job.id });
    });

    this.messageQueue.on("stalled", (job) => {
      this.logger.warn("⚠️ Job estancado", { jobId: job.id });
    });

    // Eventos de QR
    this.qrQueue.on("completed", (job) => {
      this.logger.info("✅ QR job completado", { jobId: job.id });
    });

    this.qrQueue.on("failed", (job, err) => {
      this.logger.error("❌ QR job falló", err, { jobId: job.id });
    });
  }

  /**
   * ➕ Agrega un mensaje a la cola
   *
   * @param {object} msgUpdate - Objeto mensaje de Baileys
   * @param {string} sessionId - ID de la sesión
   * @returns {Promise<Job>} - Job de Bull creado
   */
  async addMessageToQueue(msgUpdate, sessionId) {
    try {
      const job = await this.messageQueue.add(
        {
          msgUpdate,
          sessionId,
        },
        {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 2000,
          },
          timeout: this.messageProcessingTimeout,
          removeOnComplete: true,
          removeOnFail: false,
        }
      );

      const messageId = msgUpdate.messages[0]?.key?.id;
      this.logger.info("📥 Mensaje agregado a cola", {
        jobId: job.id,
        messageId,
        sessionId,
      });

      return job;
    } catch (error) {
      this.logger.error("❌ Error agregando mensaje a cola", error, {
        sessionId,
      });
      throw error;
    }
  }

  /**
   * 🔄 Configura el procesador de mensajes
   *
   * @param {Function} processorFn - Función que procesa el mensaje
   */
  processMessages(processorFn) {
    this.messageQueue.process(this.maxConcurrentMessages, async (job) => {
      const { msgUpdate, sessionId } = job.data;
      const messageId = msgUpdate.messages[0]?.key?.id;

      this.metrics.startMessage(messageId);

      try {
        this.logger.info("🔄 Procesando mensaje desde cola", {
          jobId: job.id,
          messageId,
          sessionId,
        });

        const result = await processorFn(job.data);

        await this.metrics.endMessage(messageId, true, this.messageQueue);

        return result;
      } catch (error) {
        this.logger.error("❌ Error procesando mensaje", error, {
          jobId: job.id,
          messageId,
          sessionId,
        });

        await this.metrics.endMessage(messageId, false, this.messageQueue);

        throw error;
      }
    });

    this.logger.info("✅ Procesador de mensajes configurado", {
      maxConcurrent: this.maxConcurrentMessages,
    });
  }

  /**
   * 🛡️ Ejecuta una función con circuit breaker
   *
   * @param {Function} callback - Función a ejecutar
   * @returns {Promise<any>} - Resultado de la función
   */
  async executeWithCircuitBreaker(callback) {
    return await this.circuitBreaker.execute(callback);
  }

  /**
   * 📊 Obtiene el estado del sistema de colas
   *
   * @returns {Promise<object>} - Estado completo
   */
  async getStatus() {
    try {
      const [messageQueueCounts, qrQueueCounts] = await Promise.all([
        this.messageQueue.getJobCounts(),
        this.qrQueue.getJobCounts(),
      ]);

      return {
        messageQueue: messageQueueCounts,
        qrQueue: qrQueueCounts,
        metrics: this.metrics.getMetrics(),
        circuitBreaker: this.circuitBreaker.getStatus(),
      };
    } catch (error) {
      this.logger.error("❌ Error obteniendo estado de colas", error);
      throw error;
    }
  }

  /**
   * 🧹 Limpia trabajos antiguos
   *
   * @param {number} grace - Tiempo de gracia en ms (default: 24h)
   */
  async cleanOldJobs(grace = 86400000) {
    try {
      await this.messageQueue.clean(grace, "completed");
      await this.messageQueue.clean(grace, "failed");

      this.logger.info("🧹 Trabajos antiguos limpiados");
    } catch (error) {
      this.logger.error("❌ Error limpiando trabajos", error);
    }
  }

  /**
   * 🛑 Cierra todas las conexiones gracefully
   */
  async shutdown() {
    try {
      this.logger.info("🛑 Cerrando sistema de colas...");

      if (this.messageQueue) {
        await this.messageQueue.close();
      }

      if (this.qrQueue) {
        await this.qrQueue.close();
      }

      if (this.redisClient) {
        this.redisClient.disconnect();
      }

      this.logger.info("✅ Sistema de colas cerrado correctamente");
    } catch (error) {
      this.logger.error("❌ Error cerrando colas", error);
      throw error;
    }
  }
}

module.exports = {
  QueueManager,
  CircuitBreaker,
  PerformanceMetrics,
};
