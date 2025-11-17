// src/controllers/session.controller.js

/**
 * Controller de sesiones:
 * - Crear sesión
 * - Eliminar sesión
 * - Listar / info
 */

const path = require("path");
const fs = require("fs");

module.exports = function createSessionController(whatsappService, logger) {
  return {
    // POST /start
    async start(req, res) {
      try {
        const { session_id: existingSession, webhook_token, user_id } = req.body;

        if (!webhook_token || !user_id) {
          return res
            .status(400)
            .json({ error: "webhook_token y user_id requeridos" });
        }

        const sessionId = existingSession || require("uuid").v4();

        // reset QR state + borrar auth viejo
        whatsappService.clearQrState(sessionId);
        const authDir = path.join(__dirname, "..", "..", "auth", sessionId);
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
        }

        whatsappService.tokens[sessionId] = webhook_token;

        await whatsappService.startSession(sessionId, user_id, webhook_token);

        return res.json({ success: true, session_id: sessionId });
      } catch (err) {
        logger.error("❌ Error en /start", err);
        return res.status(500).json({
          error: "Error al iniciar sesión",
          details: err.message,
        });
      }
    },

    // POST /delete-session
    async delete(req, res) {
      try {
        const { session_id } = req.body;
        if (!session_id) {
          return res.status(400).json({ error: "session_id requerido" });
        }

        await whatsappService.deleteSession(session_id);
        return res.json({ success: true });
      } catch (err) {
        logger.error("❌ Error eliminando sesión", err);
        return res
          .status(500)
          .json({ error: "No se pudo eliminar la sesión" });
      }
    },

    // GET /sessions
    list(req, res) {
      const sessions = whatsappService.listActiveSessions();
      return res.json({
        success: true,
        count: sessions.length,
        sessions,
      });
    },

    // GET /session/:sessionId
    info(req, res) {
      const { sessionId } = req.params;
      const info = whatsappService.getSessionInfo(sessionId);
      return res.json({
        success: true,
        session: info,
      });
    },
  };
};
