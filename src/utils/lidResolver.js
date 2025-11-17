/**
 * 🔍 Utilidad para resolver LIDs (Local Identifiers) de WhatsApp
 *
 * Los LIDs son identificadores temporales que usa WhatsApp Business API
 * cuando no puede obtener el número real directamente.
 * Este módulo implementa múltiples estrategias para resolverlos.
 */

const { jidNormalizedUser } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");

/**
 * 🎯 Resuelve un JID (remoteJid) a un número de teléfono limpio
 *
 * @param {string} fromRaw - El JID original (ej: "123456@lid" o "57123@s.whatsapp.net")
 * @param {string} sessionId - ID de la sesión para buscar archivos de mapeo
 * @param {object} msg - Objeto completo del mensaje (para acceder a remoteJidAlt)
 * @param {object} logger - Logger para registrar eventos
 * @returns {string|null} - Número de teléfono limpio o null si no se pudo resolver
 */
function resolveLid(fromRaw, sessionId, msg = null, logger = console) {
  let fromClean = null;

  // 📍 ESTRATEGIA 1: Usar jidNormalizedUser con remoteJidAlt (preferido)
  try {
    // remoteJidAlt es una mejor fuente para resolver LIDs
    const candidateJid = msg?.key?.remoteJidAlt || fromRaw;
    const normalized = jidNormalizedUser(candidateJid);

    if (normalized && /@s\.whatsapp\.net$/i.test(normalized)) {
      fromClean = normalized.replace(/@s\.whatsapp\.net$/i, "");
      logger.info("✅ Remitente resuelto vía jidNormalizedUser", {
        candidateJid,
        normalized,
        fromClean,
        sessionId,
      });
      return fromClean;
    }
  } catch (e) {
    logger.warn("⚠️ jidNormalizedUser falló, intentando fallback", {
      fromRaw,
      sessionId,
      error: e.message,
    });
  }

  // 📍 ESTRATEGIA 2: Si es un @s.whatsapp.net directo, extraer el número
  if (/@s\.whatsapp\.net$/i.test(fromRaw)) {
    fromClean = fromRaw.replace(/@s\.whatsapp\.net$/i, "");
    logger.info("✅ Número extraído directamente de @s.whatsapp.net", {
      fromRaw,
      fromClean,
      sessionId,
    });
    return fromClean;
  }

  // 📍 ESTRATEGIA 3: Resolver desde archivos de mapeo locales (lid-mapping-*_reverse.json)
  if (/@lid$/i.test(fromRaw)) {
    try {
      const lid = fromRaw.replace(/@lid$/i, "");
      const sessionDir = path.join(__dirname, "..", "auth", sessionId);
      const reverseMapPath = path.join(
        sessionDir,
        `lid-mapping-${lid}_reverse.json`
      );

      if (fs.existsSync(reverseMapPath)) {
        const content = fs.readFileSync(reverseMapPath, "utf8").trim();

        // El archivo puede contener JSON string o directamente el número
        let phone;
        try {
          phone = JSON.parse(content);
        } catch {
          // Si no es JSON válido, intentar extraer solo números
          phone = content.replace(/[^0-9]/g, "");
        }

        if (phone) {
          fromClean = String(phone);
          logger.info("✅ Remitente resuelto desde reverse LID mapping", {
            lid,
            fromClean,
            reverseMapPath,
            sessionId,
          });
          return fromClean;
        }
      } else {
        logger.warn("⚠️ Archivo reverse mapping no encontrado", {
          reverseMapPath,
          lid,
          sessionId,
        });
      }
    } catch (e) {
      logger.error("❌ Error leyendo reverse LID mapping", e, {
        fromRaw,
        sessionId,
      });
    }
  }

  // 📍 ESTRATEGIA 4: Fallback - extraer números directamente del JID
  if (!fromClean) {
    fromClean = fromRaw.replace(/(@s\.whatsapp\.net|@lid)$/i, "");
    logger.warn("⚠️ Usando remitente sin resolver (fallback simple)", {
      fromRaw,
      fromClean,
      sessionId,
    });
  }

  return fromClean;
}

/**
 * 🔧 Valida si un JID es de un usuario individual (no grupo)
 *
 * @param {string} jid - El JID a validar
 * @returns {boolean} - true si es un usuario individual
 */
function isValidUserJid(jid) {
  return jid && (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"));
}

/**
 * 📋 Lista todos los archivos de mapeo disponibles para una sesión
 *
 * @param {string} sessionId - ID de la sesión
 * @param {object} logger - Logger para registrar eventos
 * @returns {Array} - Array de objetos con información de los archivos de mapeo
 */
function listLidMappings(sessionId, logger = console) {
  try {
    const sessionDir = path.join(__dirname, "..", "auth", sessionId);

    if (!fs.existsSync(sessionDir)) {
      logger.warn("⚠️ Directorio de sesión no existe", {
        sessionDir,
        sessionId,
      });
      return [];
    }

    const files = fs.readdirSync(sessionDir);
    const mappings = files
      .filter(
        (f) => f.startsWith("lid-mapping-") && f.endsWith("_reverse.json")
      )
      .map((f) => {
        const lid = f.replace("lid-mapping-", "").replace("_reverse.json", "");
        const filePath = path.join(sessionDir, f);

        try {
          const content = fs.readFileSync(filePath, "utf8").trim();
          let phone;
          try {
            phone = JSON.parse(content);
          } catch {
            phone = content.replace(/[^0-9]/g, "");
          }

          return { lid, phone, filePath };
        } catch (e) {
          logger.error("❌ Error leyendo archivo de mapeo", e, { filePath });
          return null;
        }
      })
      .filter((m) => m !== null);

    logger.info("📋 Archivos de mapeo encontrados", {
      count: mappings.length,
      sessionId,
    });

    return mappings;
  } catch (e) {
    logger.error("❌ Error listando archivos de mapeo", e, { sessionId });
    return [];
  }
}

module.exports = {
  resolveLid,
  isValidUserJid,
  listLidMappings,
};
