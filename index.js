/**
 * 🚀 Servidor Node.js para WhatsApp con Baileys - VERSIÓN MODULAR
 * Integración con Laravel API
 *
 * Estructura modularizada:
 * - modules/messageReceiver.js: Recepción y procesamiento de mensajes
 * - modules/messageSender.js: Envío de mensajes con reintentos
 * - modules/queueManager.js: Gestión de colas Bull/Redis
 * - modules/whatsappManager.js: Gestión de sesiones WhatsApp
 * - utils/lidResolver.js: Resolución de LIDs
 * - utils/logger.js: Sistema de logging
 * - config/config.js: Configuración centralizada
 */

const express = require("express");
const axios = require("axios");
const http = require("http");
const https = require("https");
const { v4: uuidv4 } = require("uuid");
const Redis = require("ioredis");
const path = require("path");
const fs = require("fs");


// 📦 Importar módulos
const config = require("./config/config");
const logger = require("./utils/logger");
const { QueueManager } = require("./modules/queueManager");
const CacheManager = require("./modules/cacheManager");
const BatchQueueManager = require("./modules/batchQueueManager");
const WhatsAppManager = require("./modules/whatsappManager");
const MessageReceiver = require("./modules/messageReceiver");
const MessageSender = require("./modules/messageSender");

// 🟢 Cliente Redis global
const redisClient = new Redis({
  host: config.redisHost,
  port: config.redisPort,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// 🌐 Configurar cliente HTTP con keep-alive para alto rendimiento
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

// 🔄 Interceptor para reintentos automáticos
axiosHttp.interceptors.response.use(null, async (error) => {
  const reqConfig = error.config;

  if (!reqConfig || !reqConfig.retry) {
    reqConfig.retry = 0;
  }

  reqConfig.retryCount = reqConfig.retryCount || 0;
  const maxRetries = reqConfig.maxRetries || 3;

  if (reqConfig.retryCount >= maxRetries) {
    return Promise.reject(error);
  }

  reqConfig.retryCount += 1;

  // Backoff exponencial
  const delay = Math.pow(2, reqConfig.retryCount) * 1000;
  await new Promise((resolve) => setTimeout(resolve, delay));

  return axiosHttp(reqConfig);
});

// 🎯 Inicializar módulos
let queueManager;
let cacheManager;
let batchQueueManager;
let whatsappManager;
let messageReceiver;
let messageSender;

/**
 * 🔧 Inicializa todos los módulos del sistema
 */
async function initializeModules() {
  try {
    logger.info("🔧 Inicializando módulos del sistema...");

    // 1. Inicializar gestor de colas
    queueManager = new QueueManager(
      {
        redisHost: config.redisHost,
        redisPort: config.redisPort,
        maxConcurrentMessages: config.maxConcurrentMessages,
        messageProcessingTimeout: config.messageProcessingTimeout,
      },
      logger
    );

    await queueManager.initialize();

    // 2. Inicializar gestor de cache (NUEVO)
    // cacheManager = new CacheManager(queueManager.redis, logger);
    cacheManager = new CacheManager(redisClient, logger);

    // 3. Inicializar gestor de batching (NUEVO)
    batchQueueManager = new BatchQueueManager(
      axiosHttp,
      config.laravelApi,
      logger,
      {
        batchSize: config.batchSize,
        batchInterval: config.batchInterval,
        priorityInterval: config.priorityInterval,
      }
    );

    // 4. Inicializar gestor de WhatsApp (ACTUALIZADO)
    whatsappManager = new WhatsAppManager(
      axiosHttp,
      config.laravelApi,
      logger,
      queueManager,
      cacheManager,
      batchQueueManager
    );

    // ⏳ LIMPIEZA AUTOMÁTICA CADA 60s
setInterval(() => {
  whatsappManager.cleanupDeadSessions();
}, 60000);

    // 5. Inicializar receptor de mensajes
    messageReceiver = new MessageReceiver(axiosHttp, config.laravelApi, logger);

    // 6. Inicializar emisor de mensajes
    messageSender = new MessageSender(whatsappManager.sessions, logger);

    // 7. Configurar procesador de cola de mensajes
    queueManager.processMessages(async (jobData) => {
      const { msgUpdate, sessionId } = jobData;
      const msg = msgUpdate.messages[0];
      const sock = whatsappManager.sessions[sessionId];

      if (!sock) {
        throw new Error(`Socket no encontrado para sessionId: ${sessionId}`);
      }

      return await messageReceiver.processMessage(msg, sessionId, sock);
    });

    // 8. Configurar limpieza periódica de audios
    setInterval(() => {
      messageReceiver.cleanOldAudios(config.audioMaxAge);
    }, config.audioCleanupInterval);

    logger.info("✅ Todos los módulos inicializados correctamente");
  } catch (error) {
    logger.error("❌ Error inicializando módulos", error);
    throw error;
  }
}

// 🎯 Inicializar Express
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/**
 * 🗑️ API: Eliminar sesión de WhatsApp
 */
app.post("/delete-session", async (req, res) => {
  const { session_id } = req.body;

  if (!session_id) return res.status(400).json({ error: "session_id requerido" });

  try {
    await whatsappManager.deleteSession(session_id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "No se pudo eliminar la sesión" });
  }
});


/**
 * 🚀 API: Crear nueva sesión de WhatsApp
 */
/**
 * 🚀 API: Crear nueva sesión de WhatsApp (NUEVO FLUJO)
 */

// 🚀 API: Forzar regeneración de QR para una sesión existente
app.post("/start", async (req, res) => {
  
  try {
    const { session_id: laravelSessionId, webhook_token, user_id } = req.body;

    console.log("➡️ /start recibido:", req.body);

    if (!webhook_token || !user_id) {
      return res.status(400).json({
        error: "webhook_token y user_id requeridos",
      });
    }
    

    // Si Laravel envía sesión — usarla
    const session_id = laravelSessionId || uuidv4();

    // 1️⃣ Resetear contador QR
    if (!whatsappManager.qrSendCount) {
      whatsappManager.qrSendCount = new Map();
    }
    whatsappManager.qrSendCount.set(session_id, 0);

    // 2️⃣ Limpiar estado de QR (no invalidar Redis si no existe método)
    whatsappManager.clearQrState(session_id);

    // 3️⃣ Borrar auth viejo
    const sessionDir = path.join(__dirname, "..", "auth", session_id);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    // 4️⃣ Guardar token
    whatsappManager.tokens[session_id] = webhook_token;

    // 5️⃣ Iniciar sesión
    await whatsappManager.startSession(session_id, user_id, webhook_token);

    return res.json({
      success: true,
      session_id,
      webhook_token,
    });
  } catch (err) {
    console.error("🔥 ERROR EN /start:", err);

    return res.status(500).json({
      error: "Error al iniciar sesión",
      details: err.message,
    });
  }
});

/**
 * 📤 API: Enviar mensaje desde Laravel
 */
app.post("/send-message", async (req, res) => {
  try {
    const { session_id, wa_id, type, body, mediaUrl, caption, filename } =
      req.body;

    // Validar sesión
    if (!whatsappManager.sessions[session_id]) {
      return res.status(404).json({
        success: false,
        error: "Sesión no encontrada",
      });
    }

    logger.info("📤 Solicitud de envío de mensaje", {
      session_id,
      wa_id,
      type,
    });

    // Enviar mensaje
    const result = await messageSender.sendMessage({
      sessionId: session_id,
      waId: wa_id,
      type,
      body,
      mediaUrl,
      caption,
      filename,
    });

    return res.json(result);
  } catch (err) {
    logger.error("❌ Error enviando mensaje", err, {
      session_id: req.body.session_id,
      wa_id: req.body.wa_id,
      type: req.body.type,
    });

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * ✉️ API: Envío rápido de mensaje de texto (legacy)
 */
app.post("/send", async (req, res) => {
  try {
    const { session_id, to, message } = req.body;

    if (!whatsappManager.sessions[session_id]) {
      return res.status(404).json({
        success: false,
        error: "Sesión no encontrada",
      });
    }

    await messageSender.sendText(
      session_id,
      to.replace("@s.whatsapp.net", ""),
      message
    );

    return res.json({ success: true });
  } catch (err) {
    logger.error("❌ Error en envío rápido", err, {
      session_id: req.body.session_id,
      to: req.body.to,
    });

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * 📊 API: Health check y monitoreo
 */
app.get("/health", async (req, res) => {
  try {
    const queueStatus = await queueManager.getStatus();
    const sessions = whatsappManager.listActiveSessions();

    const health = {
      status: "OK",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      activeSessions: sessions.length,
      sessions: sessions,
      queues: queueStatus,
    };

    return res.json(health);
  } catch (error) {
    logger.error("❌ Error en health check", error);

    return res.status(500).json({
      status: "ERROR",
      error: error.message,
    });
  }
});

/**
 * 📋 API: Listar sesiones activas
 */
app.get("/sessions", (req, res) => {
  try {
    const sessions = whatsappManager.listActiveSessions();

    return res.json({
      success: true,
      count: sessions.length,
      sessions,
    });
  } catch (error) {
    logger.error("❌ Error listando sesiones", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * ℹ️ API: Información de una sesión específica
 */
app.get("/session/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const info = whatsappManager.getSessionInfo(sessionId);

    return res.json({
      success: true,
      session: info,
    });
  } catch (error) {
    logger.error("❌ Error obteniendo info de sesión", error, {
      sessionId: req.params.sessionId,
    });

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 🗑️ API: Eliminar una sesión
 */
app.delete("/session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    await whatsappManager.deleteSession(sessionId);

    return res.json({
      success: true,
      message: "Sesión eliminada correctamente",
    });
  } catch (error) {
    logger.error("❌ Error eliminando sesión", error, {
      sessionId: req.params.sessionId,
    });

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 📊 API: Métricas de batching y cache
 */
app.get("/metrics/batch", (req, res) => {
  try {
    const metrics = batchQueueManager.getMetrics();
    const content = batchQueueManager.getBatchContent();

    return res.json({
      success: true,
      metrics,
      content,
    });
  } catch (error) {
    logger.error("❌ Error obteniendo métricas de batch", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 💾 API: Métricas de cache
 */
app.get("/metrics/cache", async (req, res) => {
  try {
    const metrics = await cacheManager.getMetrics();

    return res.json({
      success: true,
      metrics,
    });
  } catch (error) {
    logger.error("❌ Error obteniendo métricas de cache", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 🛑 Manejo de shutdown graceful
 */
async function gracefulShutdown(signal) {
  logger.info(`🛑 Recibido ${signal}, cerrando gracefulmente...`);

  try {
    // Flush final de batches pendientes
    if (batchQueueManager) {
      logger.info("📤 Flusheando batches pendientes...");
      await batchQueueManager.flushAll();
      batchQueueManager.stopBatchProcessor();
    }

    // Cerrar sesiones de WhatsApp
    await whatsappManager.closeAllSessions();

    // Cerrar sistema de colas
    await queueManager.shutdown();

    logger.info("✅ Shutdown completado exitosamente");
    process.exit(0);
  } catch (error) {
    logger.error("❌ Error durante shutdown", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

/**
 * 🚀 Iniciar servidor
 */
async function startServer() {
  try {
    // Inicializar módulos
    await initializeModules();

    // Restaurar sesiones activas
    await whatsappManager.restoreSessions();

    // Iniciar servidor HTTP
    app.listen(config.port, () => {
      logger.info("🚀 Servidor iniciado correctamente", {
        port: config.port,
        laravelApi: config.laravelApi,
        redisHost: config.redisHost,
        redisPort: config.redisPort,
        environment: process.env.NODE_ENV || "development",
      });
    });
  } catch (error) {
    logger.error("❌ Error fatal al iniciar servidor", error);
    process.exit(1);
  }
}

// 🎬 Iniciar aplicación
startServer();
