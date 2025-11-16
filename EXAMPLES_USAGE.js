/**
 * 📚 Ejemplos de Uso - Arquitectura Modular WhatsAppManager
 *
 * Casos de uso avanzados y patrones de integración
 */

const WhatsAppManager = require("./modules/whatsapp");
const logger = require("./utils/logger");

// ============================================================================
// EJEMPLO 1: Inicialización Básica (index.js)
// ============================================================================

async function setupWhatsAppManager(axios, laravelApi, queueManager) {
  const whatsappManager = new WhatsAppManager(
    axios,
    laravelApi,
    logger,
    queueManager,
    {
      authDir: "./auth",
      maxRetries: 3,
      qrThrottleMs: 30000, // 30 segundos
      qrExpiresMs: 60000, // 1 minuto
    }
  );

  // Registrar callbacks de ciclo de vida
  whatsappManager.onSessionOpen(async (sessionId) => {
    logger.info("✅ Sesión abierta, usuario puede recibir mensajes", {
      sessionId,
    });
    // Notificar a cliente en tiempo real
    // await notifyClient(sessionId, 'connected');
  });

  whatsappManager.onSessionClose(async (sessionId, loggedOut) => {
    logger.info("🔌 Sesión cerrada", { sessionId, loggedOut });
    // Notificar a cliente
    // await notifyClient(sessionId, 'disconnected');
  });

  return whatsappManager;
}

// ============================================================================
// EJEMPLO 2: Escalabilidad - Monitoreo de Cientos de Usuarios
// ============================================================================

async function monitorSessions(whatsappManager, interval = 60000) {
  setInterval(() => {
    const stats = whatsappManager.getStats();

    logger.info("📊 Estadísticas del Sistema", {
      totalSessions: stats.sessions.totalSessions,
      activeSessions: stats.sessions.activeSessions,
      inactiveSessions: stats.sessions.inactiveSessions,
      pendingQR: stats.qr.pendingQR,
      trackedSessions: stats.qr.trackedSessions,
    });

    // Alertas
    if (stats.qr.pendingQR > 50) {
      logger.warn("⚠️ Muchos QR pendientes", {
        count: stats.qr.pendingQR,
      });
    }

    if (stats.sessions.inactiveSessions > stats.sessions.activeSessions) {
      logger.warn("⚠️ Más sesiones inactivas que activas", stats.sessions);
    }

    // Exportar a Prometheus/Grafana
    // prometheus.register({
    //   'whatsapp_total_sessions': stats.sessions.totalSessions,
    //   'whatsapp_active_sessions': stats.sessions.activeSessions,
    //   'whatsapp_pending_qr': stats.qr.pendingQR
    // });
  }, interval);
}

// ============================================================================
// EJEMPLO 3: API REST - Crear Nueva Sesión
// ============================================================================

app.post("/api/whatsapp/sessions", async (req, res) => {
  const { user_id } = req.body;

  try {
    const sessionId = uuidv4();

    logger.info("🚀 Creando nueva sesión", { user_id, sessionId });

    // Iniciar sesión en WhatsApp
    await whatsappManager.startSession(sessionId, user_id);

    // Guardar en BD
    await db.query(
      "INSERT INTO whatsapp_sessions (id, user_id, status) VALUES (?, ?, ?)",
      [sessionId, user_id, "pending"]
    );

    return res.json({
      success: true,
      session_id: sessionId,
      message: "Escanea el QR con tu teléfono",
    });
  } catch (error) {
    logger.error("❌ Error creando sesión", error, { user_id });
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// EJEMPLO 4: Cleanup de Sesiones Inactivas
// ============================================================================

async function cleanupInactiveSessions(whatsappManager) {
  const sessions = whatsappManager.listActiveSessions();
  const now = new Date();
  const inactivityThreshold = 30 * 60 * 1000; // 30 minutos

  for (const session of sessions) {
    const inactiveTime = now - session.lastActivity;

    if (inactiveTime > inactivityThreshold) {
      logger.info("🗑️ Eliminando sesión inactiva", {
        sessionId: session.sessionId,
        inactiveFor: `${Math.floor(inactiveTime / 60000)} minutos`,
      });

      await whatsappManager.deleteSession(session.sessionId);

      // Actualizar BD
      // await db.query(
      //   'UPDATE whatsapp_sessions SET status = ? WHERE id = ?',
      //   ['inactive', session.sessionId]
      // );
    }
  }
}

// Ejecutar cada 5 minutos
setInterval(() => cleanupInactiveSessions(whatsappManager), 5 * 60 * 1000);

// ============================================================================
// EJEMPLO 5: Soporte Multi-Servidor con Redis (FUTURO)
// ============================================================================

// Esta es una estructura para versión distribuida
async function setupDistributedWhatsAppManager(
  axios,
  laravelApi,
  queueManager,
  redisClient
) {
  const whatsappManager = new WhatsAppManager(
    axios,
    laravelApi,
    logger,
    queueManager,
    { authDir: "./auth" }
  );

  // Publicar cambios de sesión a otros servidores
  whatsappManager.onSessionOpen(async (sessionId) => {
    await redisClient.publish(
      "whatsapp:sessions:open",
      JSON.stringify({ sessionId, timestamp: new Date() })
    );
  });

  whatsappManager.onSessionClose(async (sessionId, loggedOut) => {
    await redisClient.publish(
      "whatsapp:sessions:close",
      JSON.stringify({ sessionId, loggedOut, timestamp: new Date() })
    );
  });

  // Suscribirse a cambios de otros servidores
  redisClient.subscribe("whatsapp:sessions:*", (message) => {
    logger.info("📡 Notificación desde otro servidor", JSON.parse(message));
  });

  return whatsappManager;
}

// ============================================================================
// EJEMPLO 6: Configuración por Entorno
// ============================================================================

function getWhatsAppConfig(env = process.env.NODE_ENV) {
  const configs = {
    development: {
      authDir: "./auth",
      maxRetries: 1,
      qrThrottleMs: 5000, // 5s para testing
      qrExpiresMs: 15000, // 15s para testing
    },
    staging: {
      authDir: "/data/auth",
      maxRetries: 2,
      qrThrottleMs: 15000, // 15s
      qrExpiresMs: 45000, // 45s
    },
    production: {
      authDir: "/data/auth",
      maxRetries: 3,
      qrThrottleMs: 30000, // 30s
      qrExpiresMs: 60000, // 60s
    },
  };

  return configs[env] || configs.production;
}

// ============================================================================
// EJEMPLO 7: Testing - Tests Unitarios
// ============================================================================

describe("QRManager", () => {
  let qrManager;

  beforeEach(() => {
    const mockedAxios = {
      get: jest.fn(),
      post: jest.fn(),
    };
    const mockedLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };

    qrManager = new QRManager(
      mockedAxios,
      "http://api",
      mockedLogger,
      { qrThrottleMs: 100 } // Valores bajos para testing
    );
  });

  test("debe deduplicar QR codes", async () => {
    const qr = "00000000-0000-0000-0000-000000000001";
    const sessionId = "test-session";

    // Primer envío
    await qrManager.handleQrCode(qr, sessionId, "disconnected");
    expect(mockedAxios.post).toHaveBeenCalled();

    // Segundo envío (mismo QR)
    await qrManager.handleQrCode(qr, sessionId, "disconnected");
    // No debe enviar nuevamente
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    // Tercer envío (QR diferente)
    const newQr = "11111111-1111-1111-1111-111111111111";
    await qrManager.handleQrCode(newQr, sessionId, "disconnected");
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  test("debe aplicar throttle de 100ms", async (done) => {
    const qr1 = "00000000-0000-0000-0000-000000000001";
    const qr2 = "11111111-1111-1111-1111-111111111111";
    const sessionId = "test-session";

    // Primer envío
    await qrManager.handleQrCode(qr1, sessionId, "disconnected");
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    // Segundo envío inmediatamente (diferente QR)
    await qrManager.handleQrCode(qr2, sessionId, "disconnected");
    // No debe enviar porque está en throttle
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    // Esperar a que pase el throttle
    setTimeout(async () => {
      await qrManager.handleQrCode(qr2, sessionId, "disconnected");
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      done();
    }, 150);
  });
});

describe("SessionManager", () => {
  let sessionManager;

  beforeEach(() => {
    const mockedAxios = {
      get: jest.fn(),
      post: jest.fn(),
    };
    const mockedLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };

    sessionManager = new SessionManager(
      mockedAxios,
      "http://api",
      mockedLogger
    );
  });

  test("debe registrar metadatos de sesión", () => {
    sessionManager.sessionMetadata["test-1"] = {
      userId: 123,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    const info = sessionManager.getSessionInfo("test-1");
    expect(info.userId).toBe(123);
  });

  test("debe listar sesiones activas", () => {
    // Simular 3 sesiones
    sessionManager.sessions["session-1"] = {};
    sessionManager.sessions["session-2"] = {};
    sessionManager.sessions["session-3"] = {};

    sessionManager.sessionMetadata["session-1"] = {
      userId: 1,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    sessionManager.sessionMetadata["session-2"] = {
      userId: 2,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    sessionManager.sessionMetadata["session-3"] = {
      userId: 3,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    const sessions = sessionManager.listActiveSessions();
    expect(sessions.length).toBe(3);
  });
});

// ============================================================================
// EJEMPLO 8: Graceful Shutdown
// ============================================================================

async function gracefulShutdown(whatsappManager, queueManager) {
  logger.info("🛑 Iniciando shutdown graceful...");

  try {
    // 1. Dejar de aceptar nuevas sesiones
    app.disable("requests");

    // 2. Cerrar todas las sesiones de WhatsApp
    logger.info("Cerrando sesiones WhatsApp...");
    await whatsappManager.closeAllSessions();

    // 3. Procesar mensajes pendientes
    logger.info("Finalizando cola de mensajes...");
    await queueManager.shutdown();

    logger.info("✅ Shutdown completado exitosamente");
    process.exit(0);
  } catch (error) {
    logger.error("❌ Error durante shutdown", error);
    process.exit(1);
  }
}

// Manejo de señales
process.on("SIGTERM", () => gracefulShutdown(whatsappManager, queueManager));
process.on("SIGINT", () => gracefulShutdown(whatsappManager, queueManager));

// ============================================================================
// EJEMPLO 9: Dashboard de Monitoreo
// ============================================================================

app.get("/api/admin/dashboard", (req, res) => {
  const stats = whatsappManager.getStats();
  const sessions = whatsappManager.listActiveSessions();

  return res.json({
    summary: {
      timestamp: stats.timestamp,
      totalUsers: stats.sessions.totalSessions,
      activeNow: stats.sessions.activeSessions,
      inactive: stats.sessions.inactiveSessions,
      pendingQR: stats.qr.pendingQR,
    },
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      user: s.user,
      connected: s.connected,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      // Calcular inactividad
      inactiveMinutes: Math.floor((new Date() - s.lastActivity) / 60000),
    })),
    alerts: {
      criticalSessions:
        stats.sessions.inactiveSessions > stats.sessions.activeSessions / 2,
      manyPendingQR: stats.qr.pendingQR > 10,
    },
  });
});

// ============================================================================
// EJEMPLO 10: Integración con Eventos de Negocio
// ============================================================================

async function setupBusinessLogicCallbacks(whatsappManager, db) {
  // Cuando una sesión se conecta, actualizar BD
  whatsappManager.onSessionOpen(async (sessionId) => {
    try {
      await db.query(
        "UPDATE whatsapp_sessions SET status = ?, connected_at = NOW() WHERE id = ?",
        ["connected", sessionId]
      );

      // Notificar al usuario
      // await sendNotification({
      //   type: 'whatsapp_connected',
      //   sessionId,
      //   message: 'Tu WhatsApp está conectado'
      // });
    } catch (error) {
      logger.error("Error updating session status", error, { sessionId });
    }
  });

  // Cuando una sesión se desconecta, alertar
  whatsappManager.onSessionClose(async (sessionId, loggedOut) => {
    try {
      if (loggedOut) {
        await db.query(
          "UPDATE whatsapp_sessions SET status = ?, disconnected_at = NOW() WHERE id = ?",
          ["disconnected", sessionId]
        );
      } else {
        await db.query("UPDATE whatsapp_sessions SET status = ? WHERE id = ?", [
          "reconnecting",
          sessionId,
        ]);
      }

      // Notificar al usuario
      // await sendAlert({
      //   type: 'whatsapp_disconnected',
      //   sessionId,
      //   loggedOut,
      //   message: loggedOut ?
      //     'Necesitas conectar nuevamente' :
      //     'Intentando reconectar...'
      // });
    } catch (error) {
      logger.error("Error handling session close", error, { sessionId });
    }
  });
}

// ============================================================================
// EXPORTAR FUNCIONES
// ============================================================================

module.exports = {
  setupWhatsAppManager,
  monitorSessions,
  cleanupInactiveSessions,
  setupDistributedWhatsAppManager,
  getWhatsAppConfig,
  gracefulShutdown,
  setupBusinessLogicCallbacks,
};
