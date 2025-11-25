// src/app.js

/**
 * 🚀 Punto de entrada del servidor
 * Solo orquesta:
 * - carga config
 * - inicializa servicios
 * - registra rutas
 * - restaura sesiones
 */

const express = require("express");
const axios = require("axios");
const http = require("http");
const https = require("https");
const Redis = require("ioredis");
const path = require("path");

// Config y utils
const config = require("./config/config");
const logger = require("./utils/logger");

// Servicios (módulos existentes movidos a /services)
const { QueueManager } = require("./services/queue.service");
const CacheManager = require("./services/cache.service");
const BatchQueueManager = require("./services/batch.service");
const WhatsAppService = require("./services/whatsapp"); // ✅ Cambio a estructura modular
const MessageReceiver = require("./services/receiver.service");
const MessageSender = require("./services/message.service");

// Middleware
const {
  errorMiddleware,
  notFoundHandler,
} = require("./middleware/error-handler");

// Controllers
const createSessionController = require("./controllers/session.controller");
const createMessageController = require("./controllers/message.controller");
const createHealthController = require("./controllers/health.controller");
const createMetricsController = require("./controllers/metrics.controller");

// Routes
const registerSessionRoutes = require("./routes/session.routes");
const registerMessageRoutes = require("./routes/message.routes");
const registerHealthRoutes = require("./routes/health.routes");
const registerMetricsRoutes = require("./routes/metrics.routes");

// Redis global para cache
const redisClient = new Redis({
  host: config.redisHost,
  port: config.redisPort,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Axios con keep-alive
const axiosHttp = axios.create({
  httpAgent: new http.Agent({
    keepAlive: true,
    maxSockets: config.httpMaxSockets,
    maxFreeSockets: config.httpMaxFreeSockets,
    timeout: config.httpTimeout,
    freeSocketTimeout: config.httpFreeSocketTimeout,
  }),
  httpsAgent: new https.Agent({
    keepAlive: true,
    maxSockets: config.httpMaxSockets,
    maxFreeSockets: config.httpMaxFreeSockets,
    timeout: config.httpTimeout,
    freeSocketTimeout: config.httpFreeSocketTimeout,
  }),
  timeout: config.httpTimeout,
});

async function bootstrap() {
  try {
    logger.info("🔧 Inicializando módulos...");

    // 1) Colas
    const queueManager = new QueueManager(
      {
        redisHost: config.redisHost,
        redisPort: config.redisPort,
        maxConcurrentMessages: config.maxConcurrentMessages,
        messageProcessingTimeout: config.messageProcessingTimeout,
      },
      logger
    );
    await queueManager.initialize();

    // 2) Cache
    const cacheManager = new CacheManager(redisClient, logger);

    // 3) Batch
    const batchQueueManager = new BatchQueueManager(
      axiosHttp,
      config.laravelApi,
      logger,
      {
        batchSize: config.batchSize,
        batchInterval: config.batchInterval,
        priorityInterval: config.priorityInterval,
      }
    );

    // 4) WhatsApp service
    const whatsappService = new WhatsAppService(
      axiosHttp,
      config.laravelApi,
      logger,
      queueManager,
      cacheManager,
      batchQueueManager
    );

    // 5) Message receiver / sender
    const messageReceiver = new MessageReceiver(
      axiosHttp,
      config.laravelApi,
      logger
    );
    const messageSender = new MessageSender(whatsappService.sessions, logger);

    // 6) Procesar mensajes desde la cola
    queueManager.processMessages(async (jobData) => {
      const { msgUpdate, sessionId } = jobData;
      const msg = msgUpdate.messages[0];
      const sock = whatsappService.sessions[sessionId];

      if (!sock) {
        throw new Error(`Socket no encontrado para sessionId: ${sessionId}`);
      }

      return await messageReceiver.processMessage(msg, sessionId, sock);
    });

    // 7) Limpieza periódica de sesiones muertas
    setInterval(() => whatsappService.cleanupDeadSessions(), 60000);

    // 8) Express
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use(express.urlencoded({ extended: true, limit: "10mb" }));

    // Controllers instanciados con servicios
    const sessionController = createSessionController(whatsappService, logger);
    const messageController = createMessageController(
      whatsappService,
      messageSender,
      logger
    );
    const healthController = createHealthController(
      whatsappService,
      queueManager,
      logger
    );
    const metricsController = createMetricsController(
      batchQueueManager,
      cacheManager,
      logger
    );

    // 9) Registrar rutas
    registerSessionRoutes(app, sessionController);
    registerMessageRoutes(app, messageController);
    registerHealthRoutes(app, healthController);
    registerMetricsRoutes(app, metricsController);

    // 10) Middleware de manejo de errores (DEBE IR AL FINAL)
    app.use(notFoundHandler);
    app.use(errorMiddleware(logger));

    // 11) Restaurar sesiones activas desde Laravel
    await whatsappService.restoreSessions();

    // 12) Iniciar servidor
    app.listen(config.port, () => {
      logger.info("🚀 Servidor iniciado correctamente", {
        port: config.port,
        laravelApi: config.laravelApi,
        redisHost: config.redisHost,
        redisPort: config.redisPort,
        environment: process.env.NODE_ENV || "development",
      });
    });

    // Shutdown graceful
    async function gracefulShutdown(signal) {
      logger.info(`🛑 Recibido ${signal}, cerrando gracefulmente...`);

      try {
        await batchQueueManager.flushAll?.();
        batchQueueManager.stopBatchProcessor?.();

        // ✅ Preservar credenciales en shutdown (para reconexión automática)
        await whatsappService.closeAllSessions(true); // preserveAuth = true
        await queueManager.shutdown();

        logger.info("✅ Shutdown completado");
        process.exit(0);
      } catch (error) {
        logger.error("❌ Error durante shutdown", error);
        process.exit(1);
      }
    }

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  } catch (error) {
    logger.error("❌ Error fatal en bootstrap", error);
    process.exit(1);
  }
}

// Arrancar todo
bootstrap();
