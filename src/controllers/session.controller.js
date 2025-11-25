// src/controllers/session.controller.js

/**
 * Controller de sesiones:
 * - Crear sesión
 * - Eliminar sesión
 * - Listar / info
 */

const path = require("path");
const fs = require("fs");
const {
  validateWebhookToken,
  validateSessionId,
  asyncHandler,
} = require("../middleware/validators");

module.exports = function createSessionController(whatsappService, logger) {
  return {
    // POST /start - ✅ Usa validateWebhookToken + asyncHandler
    start: [
      validateWebhookToken,
      asyncHandler(async (req, res) => {
        const {
          session_id: existingSession,
          webhook_token,
          user_id,
        } = req.body;

        const sessionId = existingSession || require("uuid").v4();

        // reset QR state + borrar auth viejo
        if (whatsappService.qrManager) {
          whatsappService.qrManager.clearQrState(sessionId);
        }

        const authDir = path.join(__dirname, "..", "..", "auth", sessionId);
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
        }

        whatsappService.tokens[sessionId] = webhook_token;

        await whatsappService.startSession(sessionId, user_id, webhook_token);

        return res.json({ success: true, session_id: sessionId });
      }),
    ],

    // POST /delete-session - ✅ Usa asyncHandler
    delete: asyncHandler(async (req, res) => {
      const { session_id } = req.body;

      if (!session_id) {
        return res.status(400).json({ error: "session_id requerido" });
      }

      await whatsappService.deleteSession(session_id);
      return res.json({ success: true });
    }),

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
