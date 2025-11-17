// src/controllers/message.controller.js

/**
 * Controller de mensajes:
 * - Envío desde Laravel
 * - Envío rápido (legacy)
 */
module.exports = function createMessageController(whatsappService, messageService, logger) {
  return {

    async sendFromLaravel(req, res) {
      try {
        const { session_id, wa_id, waId } = req.body;

        // Normalizar el waId
        const finalWaId = waId || wa_id;
        if (!finalWaId) {
          return res.status(400).json({
            success: false,
            error: "WA_ID_MISSING"
          });
        }

        const session = whatsappService.sessions[session_id];
        const sock = session?.sock;

        if (!sock || typeof sock.sendMessage !== "function") {
          return res.status(400).json({
            success: false,
            error: "SESSION_NOT_CONNECTED"
          });
        }

        const result = await messageService.sendMessage({
          ...req.body,
          waId: finalWaId,
          sessionId: session_id,
        });

        return res.json(result); // ← aquí estaba el error (antes $result)

      } catch (err) {

        logger.error("❌ Error enviando mensaje", err, {
          session_id: req.body.session_id,
          wa_id: req.body.wa_id,
          type: req.body.type,
        });

        return res.status(500).json({
          success: false,
          error: err.message
        });
      }
    },

    async sendQuick(req, res) {
      try {
        const { session_id, to, message } = req.body;

        const session = whatsappService.sessions[session_id];
        const sock = session?.sock;

        if (!sock || typeof sock.sendMessage !== "function") {
          return res.status(400).json({
            success: false,
            error: "SESSION_NOT_CONNECTED"
          });
        }

        await messageService.sendText(
          session_id,
          to.replace("@s.whatsapp.net", ""),
          message
        );

        return res.json({ success: true });

      } catch (err) {

        logger.error("❌ Error envío rápido", err, {
          session_id: req.body.session_id,
          to: req.body.to
        });

        return res.status(500).json({
          success: false,
          error: err.message
        });
      }
    }
  };
};
