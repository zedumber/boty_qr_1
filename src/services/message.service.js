/**
 * 📤 Módulo de Envío de Mensajes
 *
 * Gestiona el envío de mensajes salientes de WhatsApp:
 * - Texto con preview de URLs
 * - Imágenes con caption
 * - Audio
 * - Video con caption
 * - Documentos
 * - Reintentos automáticos y timeouts
 */

const { sleep } = require("../utils/helpers");

class MessageSender {
  constructor(sessions, logger) {
    this.sessions = sessions; // Referencia a las sesiones activas
    this.logger = logger;
    this.defaultTimeout = 15000; // 15 segundos
    this.defaultRetries = 3;
  }

  /**
   * 🔄 Envía un mensaje con reintentos y timeout
   *
   * @param {string} sessionId - ID de la sesión
   * @param {string} jid - JID del destinatario (ej: "573001234567@s.whatsapp.net")
   * @param {object} content - Contenido del mensaje según Baileys
   * @param {object} options - Opciones adicionales para sendMessage
   * @param {number} retries - Número de reintentos (default: 3)
   * @param {number} timeout - Timeout en ms (default: 15000)
   * @returns {Promise<object>} - Respuesta de Baileys
   */
  async sendWithRetry(
    sessionId,
    jid,
    content,
    options = {},
    retries = null,
    timeout = null
  ) {
    const sock = this.resolveSock(sessionId);

    if (!sock) {
      throw new Error(`Sesión no encontrada: ${sessionId}`);
    }

    const maxRetries = retries || this.defaultRetries;
    const timeoutMs = timeout || this.defaultTimeout;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`🚀 Intento de envío ${attempt}/${maxRetries}`, {
          sessionId,
          jid,
          attempt,
        });

        const result = await Promise.race([
          sock.sendMessage(jid, content, options),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout superado")), timeoutMs)
          ),
        ]);

        this.logger.info("✅ Mensaje enviado exitosamente", {
          sessionId,
          jid,
          attempt,
        });

        return result;
      } catch (err) {
        lastError = err;
        this.logger.warn(`⚠️ Error en intento ${attempt}/${maxRetries}`, err, {
          sessionId,
          jid,
          error: err.message,
        });

        // Si aún quedan intentos, esperar antes de reintentar
        if (attempt < maxRetries) {
          const backoff = 2000 * attempt; // Backoff incremental
          this.logger.info(`⏳ Esperando ${backoff}ms antes de reintentar...`, {
            sessionId,
          });
          await sleep(backoff);
        }
      }
    }

    // Si llegamos aquí, todos los intentos fallaron
    this.logger.error("❌ Todos los intentos de envío fallaron", lastError, {
      sessionId,
      jid,
      maxRetries,
    });
    throw lastError;
  }

  /**
   * 📝 Envía un mensaje de texto
   *
   * @param {string} sessionId - ID de la sesión
   * @param {string} waId - Número de WhatsApp sin @s.whatsapp.net
   * @param {string} text - Texto del mensaje
   * @returns {Promise<object>} - Respuesta del envío
   */
  async sendText(sessionId, waId, text) {
    const jid = waId + "@s.whatsapp.net";

    // Detectar si el texto tiene URLs para mostrar preview
    const hasUrl = /(https?:\/\/[^\s]+)/.test(text);

    return await this.sendWithRetry(sessionId, jid, {
      text: text,
      linkPreview: hasUrl,
    });
  }

  /**
   * 🖼️ Envía una imagen
   *
   * @param {string} sessionId - ID de la sesión
   * @param {string} waId - Número de WhatsApp sin @s.whatsapp.net
   * @param {string} mediaUrl - URL de la imagen
   * @param {string} caption - Caption opcional
   * @returns {Promise<object>} - Respuesta del envío
   */
  async sendImage(sessionId, waId, mediaUrl, caption = "") {
    const jid = waId + "@s.whatsapp.net";

    return await this.sendWithRetry(sessionId, jid, {
      image: { url: mediaUrl },
      caption: caption || "",
    });
  }

  /**
   * 🔊 Envía un audio
   *
   * @param {string} sessionId - ID de la sesión
   * @param {string} waId - Número de WhatsApp sin @s.whatsapp.net
   * @param {string} mediaUrl - URL del audio
   * @returns {Promise<object>} - Respuesta del envío
   */
  async sendAudio(sessionId, waId, mediaUrl) {
    const jid = waId + "@s.whatsapp.net";

    return await this.sendWithRetry(sessionId, jid, {
      audio: { url: mediaUrl },
      mimetype: "audio/mpeg",
    });
  }

  /**
   * 🎥 Envía un video
   *
   * @param {string} sessionId - ID de la sesión
   * @param {string} waId - Número de WhatsApp sin @s.whatsapp.net
   * @param {string} mediaUrl - URL del video
   * @param {string} caption - Caption opcional
   * @returns {Promise<object>} - Respuesta del envío
   */
  async sendVideo(sessionId, waId, mediaUrl, caption = "") {
    const jid = waId + "@s.whatsapp.net";

    return await this.sendWithRetry(sessionId, jid, {
      video: { url: mediaUrl },
      caption: caption || "",
    });
  }

  /**
   * 📄 Envía un documento
   *
   * @param {string} sessionId - ID de la sesión
   * @param {string} waId - Número de WhatsApp sin @s.whatsapp.net
   * @param {string} mediaUrl - URL del documento
   * @param {string} filename - Nombre del archivo
   * @param {string} caption - Caption opcional
   * @returns {Promise<object>} - Respuesta del envío
   */
  async sendDocument(
    sessionId,
    waId,
    mediaUrl,
    filename = "document",
    caption = ""
  ) {
    const jid = waId + "@s.whatsapp.net";

    return await this.sendWithRetry(sessionId, jid, {
      document: { url: mediaUrl },
      fileName: filename,
      caption: caption || "",
    });
  }

  /**
   * 🎯 Envía un mensaje según el tipo especificado
   *
   * @param {object} params - Parámetros del mensaje
   * @param {string} params.sessionId - ID de la sesión
   * @param {string} params.waId - Número de WhatsApp
   * @param {string} params.type - Tipo: text, image, audio, video, document
   * @param {string} params.body - Texto del mensaje (para type=text)
   * @param {string} params.mediaUrl - URL del media (para otros tipos)
   * @param {string} params.caption - Caption opcional
   * @param {string} params.filename - Nombre del archivo (para documentos)
   * @returns {Promise<object>} - Respuesta del envío
   */
  async sendMessage(params) {
    const { sessionId, waId, type, body, mediaUrl, caption, filename } = params;

    this.logger.info("📤 Enviando mensaje", {
      sessionId,
      waId,
      type,
    });

    try {
      let response;

      switch (type) {
        case "text":
          response = await this.sendText(sessionId, waId, body);
          break;

        case "image":
          response = await this.sendImage(sessionId, waId, mediaUrl, caption);
          break;

        case "audio":
          response = await this.sendAudio(sessionId, waId, mediaUrl);
          break;

        case "video":
          response = await this.sendVideo(sessionId, waId, mediaUrl, caption);
          break;

        case "document":
          response = await this.sendDocument(
            sessionId,
            waId,
            mediaUrl,
            filename,
            caption
          );
          break;

        default:
          throw new Error(`Tipo de mensaje no soportado: ${type}`);
      }

      this.logger.info("✅ Mensaje enviado correctamente", {
        sessionId,
        waId,
        type,
      });

      return { success: true, response };
    } catch (error) {
      this.logger.error("❌ Error enviando mensaje", error, {
        sessionId,
        waId,
        type,
      });
      throw error;
    }
  }

  /**
   * 📊 Obtiene el estado de una sesión
   *
   * @param {string} sessionId - ID de la sesión
   * @returns {object} - { exists: boolean, connected: boolean }
   */
  getSessionStatus(sessionId) {
    const sock = this.resolveSock(sessionId);

    return {
      exists: !!sock,
      connected: sock?.user ? true : false,
      sessionId,
    };
  }

  resolveSock(sessionId) {
    const session = this.sessions[sessionId];

    if (!session) {
      throw new Error(`Sesión no encontrada: ${sessionId}`);
    }

    // Caso 1: sock directo
    if (typeof session.sendMessage === "function") {
      return session;
    }

    // Caso 2: socket dentro de session.sock
    if (session.sock && typeof session.sock.sendMessage === "function") {
      return session.sock;
    }

    throw new Error(`Socket inválido o corrupto en sesión: ${sessionId}`);
  }
}

module.exports = MessageSender;
