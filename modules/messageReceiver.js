/**
 * 📥 Módulo de Recepción de Mensajes
 *
 * Gestiona todo el procesamiento de mensajes entrantes de WhatsApp:
 * - Resolución de LIDs
 * - Descarga de archivos multimedia
 * - Preparación de datos para envío a Laravel
 */

const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const { resolveLid, isValidUserJid } = require("../utils/lidResolver");

class MessageReceiver {
  constructor(axiosInstance, laravelApi, logger) {
    this.axios = axiosInstance;
    this.laravelApi = laravelApi;
    this.logger = logger;
    this.audioDir = path.join(__dirname, "..", "audios");

    // Crear directorio de audios si no existe
    if (!fs.existsSync(this.audioDir)) {
      fs.mkdirSync(this.audioDir, { recursive: true });
    }
  }

  /**
   * 🎯 Procesa un mensaje entrante
   *
   * @param {object} msg - Objeto mensaje de Baileys
   * @param {string} sessionId - ID de la sesión
   * @param {object} sock - Socket de WhatsApp
   * @returns {object} - Resultado del procesamiento
   */
  async processMessage(msg, sessionId, sock) {
    const messageId = msg.key.id;

    try {
      // 🚫 Validar que el mensaje tenga contenido
      if (!msg.message) {
        this.logger.warn("⚠️ Mensaje sin contenido, ignorando", {
          messageId,
          sessionId,
        });
        return { success: true, skipped: true, reason: "no-content" };
      }

      // 🚫 Ignorar mensajes propios
      if (msg.key.fromMe) {
        this.logger.warn("⚠️ Mensaje propio, ignorando", {
          messageId,
          sessionId,
        });
        return { success: true, skipped: true, reason: "from-me" };
      }

      const fromRaw = msg.key.remoteJid;

      // 🚫 Validar tipo de remitente (solo usuarios individuales)
      if (!isValidUserJid(fromRaw)) {
        this.logger.warn("⚠️ Mensaje descartado por tipo de remitente", {
          fromRaw,
          messageId,
          sessionId,
        });
        return { success: true, skipped: true, reason: "invalid-jid-type" };
      }

      // 🔍 Resolver el número real del remitente (manejar LIDs)
      const fromClean = resolveLid(fromRaw, sessionId, msg, this.logger);

      if (!fromClean) {
        this.logger.error("❌ No se pudo resolver el remitente", {
          fromRaw,
          messageId,
          sessionId,
        });
        return { success: false, error: "unresolved-sender" };
      }

      const pushName = msg.pushName || fromClean;

      // 📝 Extraer contenido del mensaje
      const messageData = await this.extractMessageContent(
        msg,
        fromClean,
        sessionId
      );

      this.logger.info("📨 Nuevo mensaje recibido", {
        fromClean,
        pushName,
        type: messageData.type,
        messageId,
        sessionId,
      });

      // 📤 Enviar a Laravel
      await this.sendToLaravel(
        messageData,
        msg,
        sessionId,
        pushName,
        fromClean
      );

      this.logger.info("✅ Mensaje enviado a Laravel", {
        fromClean,
        messageId,
        sessionId,
      });

      return { success: true, messageId, from: fromClean };
    } catch (error) {
      this.logger.error("❌ Error procesando mensaje", error, {
        messageId,
        sessionId,
      });
      throw error;
    }
  }

  /**
   * 📝 Extrae el contenido de un mensaje según su tipo
   *
   * @param {object} msg - Objeto mensaje
   * @param {string} fromClean - Número del remitente limpio
   * @param {string} sessionId - ID de la sesión
   * @returns {object} - Datos del mensaje { type, text, filename }
   */
  async extractMessageContent(msg, fromClean, sessionId) {
    let type = "text";
    let text = "";
    let filename = null;

    // 📝 Mensaje de texto
    if (msg.message.conversation) {
      text = msg.message.conversation;
    } else if (msg.message.extendedTextMessage?.text) {
      text = msg.message.extendedTextMessage.text;
    } else if (msg.message.imageMessage?.caption) {
      text = msg.message.imageMessage.caption;
      type = "image";
    }

    // 🔊 Mensaje de audio
    if (msg.message.audioMessage) {
      const audioData = await this.downloadAudio(
        msg.message.audioMessage,
        fromClean,
        msg.key.id
      );
      type = "audio";
      text = "[Mensaje de audio]";
      filename = audioData.filename;
    }

    // 🖼️ Mensaje de imagen
    if (msg.message.imageMessage && type !== "image") {
      type = "image";
      text = msg.message.imageMessage.caption || "[Imagen]";
    }

    // 🎥 Mensaje de video
    if (msg.message.videoMessage) {
      type = "video";
      text = msg.message.videoMessage.caption || "[Video]";
    }

    // 📄 Mensaje de documento
    if (msg.message.documentMessage) {
      type = "document";
      text = msg.message.documentMessage.caption || "[Documento]";
    }

    return { type, text, filename };
  }

  /**
   * 🔊 Descarga y guarda un archivo de audio
   *
   * @param {object} audioMsg - Objeto audioMessage de Baileys
   * @param {string} fromClean - Número del remitente
   * @param {string} messageId - ID del mensaje
   * @returns {object} - { filename, mimetype, extension }
   */
  async downloadAudio(audioMsg, fromClean, messageId) {
    try {
      const mime = audioMsg.mimetype || "audio/ogg";
      const ext = mime.split("/")[1].split(";")[0] || "ogg";

      // Descargar el stream
      const stream = await downloadContentFromMessage(audioMsg, "audio");
      const chunks = [];

      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);

      // Guardar en archivo
      const filename = path.join(
        this.audioDir,
        `${fromClean}_${messageId}.${ext}`
      );
      fs.writeFileSync(filename, buffer);

      this.logger.info("🔊 Audio guardado", {
        filename,
        size: buffer.length,
        mimetype: mime,
      });

      return { filename, mimetype: mime, extension: ext };
    } catch (error) {
      this.logger.error("❌ Error descargando audio", error, {
        fromClean,
        messageId,
      });
      throw error;
    }
  }

  /**
   * 📤 Envía el mensaje procesado a Laravel
   *
   * @param {object} messageData - Datos del mensaje { type, text, filename }
   * @param {object} msg - Mensaje original completo
   * @param {string} sessionId - ID de la sesión
   * @param {string} pushName - Nombre del contacto
   * @param {string} fromClean - Número limpio del remitente
   */
  async sendToLaravel(messageData, msg, sessionId, pushName, fromClean) {
    try {
      // 🔑 Obtener token de webhook
      const { data } = await this.axios.get(
        `${this.laravelApi}/whatsapp/account/${sessionId}`
      );
      const accountToken = data.webhook_token;

      // 📦 Preparar FormData
      const form = new FormData();
      form.append("from", fromClean);
      form.append("text", messageData.text);
      form.append("type", messageData.type);
      form.append("wamId", msg.key.id);
      form.append("timestamp", msg.messageTimestamp);
      form.append("pushName", pushName);

      // 📎 Adjuntar archivo si existe
      if (messageData.filename && fs.existsSync(messageData.filename)) {
        form.append("audio", fs.createReadStream(messageData.filename));
      }

      // 🚀 Enviar a Laravel
      await this.axios.post(
        `${this.laravelApi}/whatsapp-webhook/${accountToken}`,
        form,
        {
          headers: form.getHeaders(),
          maxBodyLength: Infinity,
        }
      );

      this.logger.info("✅ Datos enviados a Laravel webhook", {
        sessionId,
        fromClean,
        type: messageData.type,
      });
    } catch (error) {
      this.logger.error("❌ Error enviando datos a Laravel", error, {
        sessionId,
        fromClean,
      });
      throw error;
    }
  }

  /**
   * 🧹 Limpia archivos de audio antiguos
   *
   * @param {number} maxAgeMs - Edad máxima en milisegundos (default: 1 hora)
   */
  cleanOldAudios(maxAgeMs = 3600 * 1000) {
    try {
      if (!fs.existsSync(this.audioDir)) return;

      const now = Date.now();
      const files = fs.readdirSync(this.audioDir);
      let cleanedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.audioDir, file);

        try {
          const stats = fs.statSync(filePath);

          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            cleanedCount++;
          }
        } catch (err) {
          this.logger.error("❌ Error eliminando audio", err, { file });
        }
      }

      if (cleanedCount > 0) {
        this.logger.info("🧹 Archivos de audio antiguos eliminados", {
          count: cleanedCount,
        });
      }
    } catch (error) {
      this.logger.error("❌ Error en limpieza de audios", error);
    }
  }
}

module.exports = MessageReceiver;
