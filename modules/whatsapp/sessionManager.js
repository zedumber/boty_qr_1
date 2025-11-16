/**
 * 📱 Session Manager
 * Gestiona: creación, eliminación, restauración y listado de sesiones WhatsApp
 * Responsabilidades:
 * - Inicializar sesiones con Baileys
 * - Cargar/guardar credenciales
 * - Restaurar sesiones activas desde Laravel
 * - Eliminar sesiones de manera segura
 * - Mantener registro de sesiones en memoria
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

class SessionManager {
  constructor(axios, laravelApi, logger, config = {}) {
    this.axios = axios;
    this.laravelApi = laravelApi;
    this.logger = logger;

    // Configuración
    this.authDir = config.authDir || path.join(__dirname, "..", "..", "auth");
    this.maxRetries = config.maxRetries || 3;
    this.backoffBase = config.backoffBase || 600;
    this.backoffJitter = config.backoffJitter || 400;

    // Almacenamiento en memoria
    this.sessions = {}; // { sessionId: socket }
    this.sessionMetadata = {}; // { sessionId: { userId, createdAt, lastActivity } }
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
  async postLaravel(path, body, attempts = this.maxRetries) {
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
          this.backoffBase * Math.pow(2, tryNum - 1) +
          Math.floor(Math.random() * this.backoffJitter);

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
  async getSessionStatus(sessionId) {
    try {
      const { data } = await this.axios.get(
        `${this.laravelApi}/whatsapp/status/${sessionId}`
      );
      return data?.estado_qr;
    } catch (error) {
      this.logger.error("❌ Error obteniendo estado de sesión", error, {
        sessionId,
      });
      throw error;
    }
  }

  /**
   * ✅ Verifica si una sesión está activa en Laravel
   */
  async isSessionActive(sessionId) {
    try {
      const estado = await this.getSessionStatus(sessionId);
      return !!estado;
    } catch (err) {
      this.logger.error("❌ Error verificando sesión en Laravel", err, {
        sessionId,
      });
      return false;
    }
  }

  /**
   * 🚀 Inicia una nueva sesión de WhatsApp
   */
  async startSession(sessionId, userId, eventManager) {
    try {
      this.logger.info("🚀 Iniciando sesión", { sessionId, userId });

      // Crear directorio de sesión
      const sessionDir = path.join(this.authDir, sessionId);

      if (!fs.existsSync(sessionDir)) {
        this.logger.info("📁 Creando directorio de sesión", { sessionDir });
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      // Cargar credenciales
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      // Crear socket WhatsApp
      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["boty-SaaS", "Chrome", "1.0"],
        printQRInTerminal: false,
      });

      // Guardar credenciales en eventos
      sock.ev.on("creds.update", saveCreds);

      // Registrar sesión
      this.sessions[sessionId] = sock;
      this.sessionMetadata[sessionId] = {
        userId,
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      // Registrar listeners de eventos
      if (eventManager) {
        eventManager.registerSessionEvents(sessionId, sock, userId);
      }

      this.logger.info("✅ Sesión iniciada correctamente", { sessionId });

      return sock;
    } catch (error) {
      this.logger.error("❌ Error iniciando sesión", error, {
        sessionId,
        userId,
      });
      throw error;
    }
  }

  /**
   * 🗑️ Elimina una sesión de manera segura
   */
  async deleteSession(sessionId) {
    try {
      this.logger.info("🗑️ Eliminando sesión", { sessionId });

      // Cerrar socket si existe
      if (this.sessions[sessionId]) {
        const sock = this.sessions[sessionId];
        sock.end();
        delete this.sessions[sessionId];
      }

      // Eliminar metadatos
      delete this.sessionMetadata[sessionId];

      // Eliminar archivos de autenticación
      const sessionDir = path.join(this.authDir, sessionId);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }

      this.logger.info("✅ Sesión eliminada", { sessionId });
    } catch (error) {
      this.logger.error("❌ Error eliminando sesión", error, { sessionId });
      throw error;
    }
  }

  /**
   * 📊 Obtiene información de una sesión
   */
  getSessionInfo(sessionId) {
    const sock = this.sessions[sessionId];
    const metadata = this.sessionMetadata[sessionId];

    return {
      sessionId,
      exists: !!sock,
      connected: sock?.user ? true : false,
      user: sock?.user || null,
      userId: metadata?.userId || null,
      createdAt: metadata?.createdAt || null,
      lastActivity: metadata?.lastActivity || null,
    };
  }

  /**
   * 📋 Lista todas las sesiones activas
   */
  listActiveSessions() {
    return Object.keys(this.sessions).map((sessionId) =>
      this.getSessionInfo(sessionId)
    );
  }

  /**
   * 🔄 Actualiza el tiempo de última actividad
   */
  updateLastActivity(sessionId) {
    if (this.sessionMetadata[sessionId]) {
      this.sessionMetadata[sessionId].lastActivity = new Date();
    }
  }

  /**
   * 🔄 Restaura todas las sesiones activas desde Laravel
   */
  async restoreSessions(eventManager) {
    try {
      this.logger.info("🔄 Restaurando sesiones activas...");

      const { data: accounts } = await this.axios.get(
        `${this.laravelApi}/whatsapp/accounts/active`
      );

      if (!accounts || accounts.length === 0) {
        this.logger.info("ℹ️ No hay cuentas activas para restaurar");
        return;
      }

      this.logger.info(`📋 Encontradas ${accounts.length} cuentas activas`);

      for (const account of accounts) {
        try {
          this.logger.info("🔄 Restaurando sesión", {
            accountId: account.id,
            sessionId: account.session_id,
          });

          await this.startSession(
            account.session_id,
            account.user_id,
            eventManager
          );
        } catch (err) {
          this.logger.error("❌ Error restaurando sesión", err, {
            accountId: account.id,
          });
        }
      }

      this.logger.info("✅ Proceso de restauración completado");
    } catch (err) {
      this.logger.error("❌ Error restaurando sesiones", err);
    }
  }

  /**
   * 🛑 Cierra todas las sesiones
   */
  async closeAllSessions() {
    this.logger.info("🛑 Cerrando todas las sesiones...");

    const sessionIds = Object.keys(this.sessions);

    for (const sessionId of sessionIds) {
      try {
        await this.deleteSession(sessionId);
      } catch (err) {
        this.logger.error("❌ Error cerrando sesión", err, { sessionId });
      }
    }

    this.logger.info("✅ Todas las sesiones cerradas");
  }

  /**
   * 📊 Obtiene estadísticas de sesiones
   */
  getSessionStats() {
    const sessions = Object.values(this.sessionMetadata);
    const now = new Date();

    return {
      totalSessions: sessions.length,
      activeSessions: Object.values(this.sessions).filter((s) => s?.user)
        .length,
      inactiveSessions: sessions.filter((s) => {
        const age = now - s.lastActivity;
        return age > 5 * 60 * 1000; // Inactivas por más de 5 minutos
      }).length,
      oldestSession: Math.min(...sessions.map((s) => now - s.createdAt)),
    };
  }
}

module.exports = SessionManager;
