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
 * 🔌 Circuit Breaker Pattern Mejorado
 * Protege servicios externos de sobrecarga con backoff adaptativo
 * Soporta 200+ usuarios con recuperación inteligente
 */
class CircuitBreaker {
  constructor(failureThreshold = 10, resetTimeout = 120000) {
    this.failureThreshold = failureThreshold; // más tolerancia para picos
    this.resetTimeout = resetTimeout; // 2 minutos antes de reintentar
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.state = "CLOSED"; // CLOSED, OPEN, HALF_OPEN
    this.openCount = 0; // número de veces que se abrió (para métricas)
  }

  async execute(callback) {
    if (this.state === "OPEN") {
      // Aumentar timeout de reset progresivamente
      const timeElapsed = Date.now() - this.lastFailureTime;
      const adjustedResetTime =
        this.resetTimeout * (1 + Math.log(this.openCount) / 10);

      if (timeElapsed > adjustedResetTime) {
        this.state = "HALF_OPEN";
      } else {
        throw new Error(
          `Circuit breaker OPEN (retry in ${Math.round(
            adjustedResetTime - timeElapsed
          )}ms)`
        );
      }
    }

    try {
      const result = await callback();

      if (this.state === "HALF_OPEN") {
        this.state = "CLOSED";
        this.failureCount = 0;
        this.successCount = 0;
        this.openCount = 0;
      } else if (this.state === "CLOSED") {
        this.successCount++;
        // Resetear contadores si hay éxito consistente
        if (this.successCount > 10) {
          this.failureCount = Math.max(0, this.failureCount - 1);
        }
      }

      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.failureThreshold) {
        this.state = "OPEN";
        this.openCount++;
      }

      throw error;
    }
  }

  getStatus() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      openCount: this.openCount,
    };
  }

  reset() {
    this.failureCount = 0;
    this.successCount = 0;
    this.state = "CLOSED";
    this.openCount = 0;
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
      db: config.redisDb || 0,
      maxRetriesPerRequest:
        config.redisMaxRetriesPerRequest !== undefined
          ? config.redisMaxRetriesPerRequest
          : null,
      enableReadyCheck:
        config.redisEnableReadyCheck !== undefined
          ? config.redisEnableReadyCheck
          : false,
      enableOfflineQueue:
        config.redisEnableOfflineQueue !== undefined
          ? config.redisEnableOfflineQueue
          : true,
    };

    // Instancias
    this.messageQueue = null;
    this.qrQueue = null;
    this.redisClient = null;

    // Circuit Breaker escalado para 200+ usuarios
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold || 10,
      this.config.circuitBreakerResetTimeout || 120000
    );

    this.metrics = new PerformanceMetrics(logger);

    // Configuraciones escaladas
    this.maxConcurrentMessages = config.maxConcurrentMessages || 20;
    this.maxConcurrentQrGeneration = config.maxConcurrentQrGeneration || 10;
    this.messageProcessingTimeout = config.messageProcessingTimeout || 45000;
    this.qrGenerationTimeout = config.qrGenerationTimeout || 30000;
  }

  /**
   * 🚀 Inicializa las colas y conexiones - Optimizado para 200+ usuarios
   */
  async initialize() {
    try {
      this.logger.info("🔄 Inicializando sistema de colas escalado...", {
        redisHost: this.redisConfig.host,
        redisPort: this.redisConfig.port,
        maxConcurrentMessages: this.maxConcurrentMessages,
        maxConcurrentQr: this.maxConcurrentQrGeneration,
        circuitBreakerThreshold: this.config.circuitBreakerThreshold || 10,
      });

      // Crear cliente Redis con configuración optimizada
      this.redisClient = new Redis(this.redisConfig);

      this.redisClient.on("connect", () => {
        this.logger.info("✅ Conectado a Redis");
      });

      this.redisClient.on("error", (err) => {
        this.logger.error("❌ Error de conexión a Redis", err);
      });

      // Crear colas separadas: mensajes y QRs
      this.messageQueue = new Queue("whatsapp-messages", {
        redis: this.redisConfig,
        defaultJobOptions: {
          attempts: this.config.messageMaxRetries || 5,
          backoff: {
            type: "exponential",
            delay: this.config.messageRetryDelay || 3000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      });

      // Cola separada para QRs - no interfiere con mensajes
      this.qrQueue = new Queue("qr-generation", {
        redis: this.redisConfig,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      });

      // Cola para tareas hacia Laravel (persistente y reintentable)
      this.laravelQueue = new Queue("laravel-tasks", {
        redis: this.redisConfig,
        defaultJobOptions: {
          attempts: this.config.laravelMaxRetries || 5,
          backoff: {
            type: "exponential",
            delay: this.config.laravelRetryDelay || 2000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      });

      // Configurar event listeners
      this.setupQueueEvents();

      this.logger.info(
        "✅ Sistema de colas inicializado correctamente (200+ ready)"
      );
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

    // Eventos de Laravel tasks
    if (this.laravelQueue) {
      this.laravelQueue.on("completed", (job) => {
        this.logger.info("✅ Laravel job completado", { jobId: job.id });
      });

      this.laravelQueue.on("failed", (job, err) => {
        this.logger.error("❌ Laravel job falló", err, { jobId: job.id });
      });
    }
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
   * 🔄 Configura el procesador de mensajes (hasta 20 simultáneos)
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
   * 📲 Agrega trabajo de generación QR a la cola (procesamiento paralelo)
   *
   * @param {string} qr - Código QR string
   * @param {string} sessionId - ID de sesión
   * @returns {Promise<Job>}
   */
  async addQrToQueue(qr, sessionId) {
    try {
      const job = await this.qrQueue.add(
        { qr, sessionId },
        {
          priority: 5, // QRs tienen prioridad media
          timeout: this.qrGenerationTimeout,
        }
      );

      this.logger.info("📲 QR agregado a cola", { jobId: job.id, sessionId });
      return job;
    } catch (error) {
      this.logger.error("❌ Error agregando QR a cola", error, { sessionId });
      throw error;
    }
  }

  /**
   * ➕ Agrega una tarea hacia Laravel a la cola persistente
   * @param {object} task - { path, payload, type, session_id }
   * @returns {Promise<Job>}
   */
  async addLaravelTaskToQueue(task) {
    try {
      const job = await this.laravelQueue.add(task, {
        attempts: this.config.laravelMaxRetries || 5,
        backoff: {
          type: "exponential",
          delay: this.config.laravelRetryDelay || 2000,
        },
        removeOnComplete: true,
      });

      this.logger.info("📥 Laravel task agregada a cola", {
        jobId: job.id,
        type: task.type,
        session: task.session_id,
      });
      return job;
    } catch (error) {
      this.logger.error("❌ Error agregando Laravel task a cola", error, {
        task,
      });
      throw error;
    }
  }

  /**
   * 🎯 Configura procesador de QRs (hasta 10 simultáneos, no bloquea mensajes)
   *
   * @param {Function} processorFn - Función que procesa y envía QR
   */
  processQrGeneration(processorFn) {
    this.qrQueue.process(this.maxConcurrentQrGeneration, async (job) => {
      const { qr, sessionId } = job.data;

      try {
        this.logger.info("📲 Procesando QR desde cola", {
          jobId: job.id,
          sessionId,
        });

        const result = await processorFn(job.data);

        return result;
      } catch (error) {
        this.logger.error("❌ Error procesando QR", error, {
          jobId: job.id,
          sessionId,
        });

        throw error;
      }
    });

    this.logger.info("✅ Procesador de QR configurado", {
      maxConcurrent: this.maxConcurrentQrGeneration,
    });
  }

  /**
   * 🔁 Configura procesador para tareas hacia Laravel (cola persistente)
   * @param {Function} processorFn - Función que procesa la tarea (job.data)
   */
  processLaravelTasks(processorFn) {
    const concurrency = this.config.laravelConcurrency || 2;

    this.laravelQueue.process(concurrency, async (job) => {
      try {
        this.logger.info("🔄 Procesando Laravel task desde cola", {
          jobId: job.id,
        });

        const result = await processorFn(job.data);

        return result;
      } catch (error) {
        this.logger.error("❌ Error procesando Laravel task", error, {
          jobId: job.id,
        });
        throw error;
      }
    });

    this.logger.info("✅ Procesador de Laravel tasks configurado", {
      concurrency,
    });
  }

  /**
   * 🔄 Configura el procesador de mensajes (hasta 20 simultáneos)
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
      const [messageQueueCounts, qrQueueCounts, laravelQueueCounts] =
        await Promise.all([
          this.messageQueue.getJobCounts(),
          this.qrQueue.getJobCounts(),
          this.laravelQueue
            ? this.laravelQueue.getJobCounts()
            : Promise.resolve({}),
        ]);

      return {
        messageQueue: messageQueueCounts,
        qrQueue: qrQueueCounts,
        laravelQueue: laravelQueueCounts,
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

      if (this.laravelQueue) {
        await this.laravelQueue.close();
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
