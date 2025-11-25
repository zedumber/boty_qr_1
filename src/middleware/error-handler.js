// src/middleware/error-handler.js

/**
 * ⚠️ Middleware de Manejo de Errores
 *
 * Centraliza el manejo de errores HTTP en toda la aplicación.
 */

/**
 * 🔴 Clase de error personalizada
 */
class AppError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * ⚠️ Middleware global de manejo de errores
 */
const errorMiddleware = (logger) => {
  return (err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    const message = err.message || "Error interno del servidor";

    // Log del error
    if (statusCode >= 500) {
      logger.error("❌ Error del servidor", err, {
        method: req.method,
        path: req.path,
        body: req.body,
      });
    } else {
      logger.warn("⚠️ Error del cliente", {
        statusCode,
        message,
        method: req.method,
        path: req.path,
      });
    }

    // Respuesta al cliente
    const response = {
      success: false,
      error: message,
    };

    if (err.details) {
      response.details = err.details;
    }

    // En desarrollo, incluir stack trace
    if (process.env.NODE_ENV === "development" && err.stack) {
      response.stack = err.stack;
    }

    res.status(statusCode).json(response);
  };
};

/**
 * 🚫 Handler para rutas no encontradas
 */
const notFoundHandler = (req, res, next) => {
  const error = new AppError(
    `Ruta no encontrada: ${req.method} ${req.path}`,
    404
  );
  next(error);
};

module.exports = {
  AppError,
  errorMiddleware,
  notFoundHandler,
};
