// src/controllers/message.controller.js

/**
 * Controller de mensajes:
 * - Envío desde Laravel
 * - Envío rápido (legacy)
 */

const { validateSession, asyncHandler } = require("../middleware/validators");

module.exports = function createMessageController(
  whatsappService,
  messageService,
  logger
) {
  return {
    // ✅ Usa validateSession middleware + asyncHandler
    sendFromLaravel: [
      validateSession(whatsappService),
      asyncHandler(async (req, res) => {
        const { wa_id, waId } = req.body;

        // Normalizar el waId
        const finalWaId = waId || wa_id;
        if (!finalWaId) {
          return res.status(400).json({
            success: false,
            error: "WA_ID_MISSING",
          });
        }

        const result = await messageService.sendMessage({
          ...req.body,
          waId: finalWaId,
          sessionId: req.sessionId,
        });

        return res.json(result);
      }),
    ],

    // ✅ Usa validateSession middleware + asyncHandler
    sendQuick: [
      validateSession(whatsappService),
      asyncHandler(async (req, res) => {
        const { to, message } = req.body;

        await messageService.sendText(
          req.sessionId,
          to.replace("@s.whatsapp.net", ""),
          message
        );

        return res.json({ success: true });
      }),
    ],
  };
};
