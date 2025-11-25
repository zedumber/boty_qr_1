// src/middleware/validators.js

/**
 * ✅ Middleware de Validación
 *
 * Centraliza validaciones comunes en todos los controllers:
 * - Validación de sesión activa
 * - Validación de socket conectado
 * - Validación de webhook_token
 */

/**
 * 🔐 Valida que exista webhook_token y user_id
 */
const validateWebhookToken = (req, res, next) => {
  const { webhook_token, user_id } = req.body;

  if (!webhook_token || !user_id) {
    return res.status(400).json({
      success: false,
      error: "webhook_token y user_id son requeridos",
    });
  }

  next();
};

/**
 * 🔌 Valida que la sesión tenga un socket conectado
 */
const validateSession = (whatsappService) => {
  return (req, res, next) => {
    const sessionId = req.params.sessionId || req.body.session_id;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: "session_id es requerido",
      });
    }

    const session = whatsappService.sessions[sessionId];
    const sock = session?.sock;

    if (!sock || typeof sock.sendMessage !== "function") {
      return res.status(400).json({
        success: false,
        error: "SESSION_NOT_CONNECTED",
        message: `La sesión ${sessionId} no está conectada`,
      });
    }

    // Adjuntar al request para uso posterior
    req.session = session;
    req.sock = sock;
    req.sessionId = sessionId;

    next();
  };
};

/**
 * 📱 Valida que exista session_id en body o params
 */
const validateSessionId = (req, res, next) => {
  const sessionId = req.params.sessionId || req.body.session_id;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "session_id es requerido",
    });
  }

  req.sessionId = sessionId;
  next();
};

/**
 * 🎯 Wrapper para funciones async (evita try/catch repetitivos)
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

module.exports = {
  validateWebhookToken,
  validateSession,
  validateSessionId,
  asyncHandler,
};
