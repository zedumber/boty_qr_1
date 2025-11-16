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

// 📦 Importar módulos
const config = require("./config/config");
const logger = require("./utils/logger");
const { QueueManager } = require("./modules/queueManager");
const WhatsAppManager = require("./modules/whatsapp"); // Nueva arquitectura modular
const MessageReceiver = require("./modules/messageReceiver");
const MessageSender = require("./modules/messageSender");

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

    // 2. Inicializar gestor de WhatsApp
    whatsappManager = new WhatsAppManager(
      axiosHttp,
      config.laravelApi,
      logger,
      queueManager,
      {
        authDir: config.authDir,
        maxRetries: config.maxRetries || 3,
        qrThrottleMs: config.qrThrottleMs || 30000,
        qrExpiresMs: config.qrExpiresMs || 60000,
      }
    );

    // 3. Inicializar receptor de mensajes
    messageReceiver = new MessageReceiver(axiosHttp, config.laravelApi, logger);

    // 4. Inicializar emisor de mensajes
    messageSender = new MessageSender(whatsappManager.sessions, logger);

    // 5. Configurar procesador de cola de mensajes
    queueManager.processMessages(async (jobData) => {
      const { msgUpdate, sessionId } = jobData;
      const msg = msgUpdate.messages[0];
      const sock = whatsappManager.sessions[sessionId];

      if (!sock) {
        throw new Error(`Socket no encontrado para sessionId: ${sessionId}`);
      }

      return await messageReceiver.processMessage(msg, sessionId, sock);
    });

    // 6. Configurar limpieza periódica de audios
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
 * 🚀 API: Crear nueva sesión de WhatsApp
 */
app.post("/start", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id es requerido",
      });
    }

    const sessionId = uuidv4();

    logger.info("📱 Creando nueva sesión", { user_id, sessionId });

    await whatsappManager.startSession(sessionId, user_id);

    return res.json({
      success: true,
      session_id: sessionId,
    });
  } catch (err) {
    logger.error("❌ Error creando sesión", err, {
      user_id: req.body.user_id,
    });

    return res.status(500).json({
      success: false,
      error: "No se pudo crear la sesión",
      message: err.message,
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
 * 🛑 Manejo de shutdown graceful
 */
async function gracefulShutdown(signal) {
  logger.info(`🛑 Recibido ${signal}, cerrando gracefulmente...`);

  try {
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
