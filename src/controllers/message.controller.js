// src/controllers/message.controller.js

/**
 * Controller de mensajes:
 * - Envío desde Laravel
 * - Envío rápido (legacy)
 */

module.exports = function createMessageController(
  whatsappService,
  messageService,
  logger
) {
  return {
    // POST /send-message
    async sendFromLaravel(req, res) {
      try {
        const { session_id } = req.body;

        if (!whatsappService.sessions[session_id]) {
          return res.status(404).json({
            success: false,
            error: "Sesión no encontrada",
          });
        }

        const result = await messageService.sendMessage({
          ...req.body,
          sessionId: session_id,
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
    },

    // POST /send  (rápido texto)
    async sendQuick(req, res) {
      try {
        const { session_id, to, message } = req.body;

        if (!whatsappService.sessions[session_id]) {
          return res.status(404).json({
            success: false,
            error: "Sesión no encontrada",
          });
        }

        await messageService.sendText(
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
    },
  };
};
