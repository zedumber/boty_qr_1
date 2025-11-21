/**
 * 🔍 Resolución de LIDs (Local Identifiers) para Baileys 7.x
 *
 * WhatsApp en Baileys 7.x maneja LIDs con archivos automáticos:
 *
 *   auth/<sessionId>/lids/lid-mapping-XXXX.json
 *   auth/<sessionId>/lids/lid-mapping-XXXX_reverse.json
 *
 * Además, expone:
 *   msg.key.remoteJidAlt
 *   msg.key.participantAlt
 *   msg.key.participant
 *
 * Este módulo resuelve el JID real usando todas esas fuentes
 * y CREA el reverse mapping si no existe.
 */

const { jidNormalizedUser } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");

// Memoria viva: LID → número real
global.__LID_MEMORY__ = global.__LID_MEMORY__ || {};

/**
 * 🎯 Resuelve un JID (lid o s.whatsapp.net) a un número limpio
 *
 * @param {string} fromRaw
 * @param {string} sessionId
 * @param {object} msg
 * @param {object} logger
 * @returns {string|null}
 */
function resolveLid(fromRaw, sessionId, msg = null, logger = console) {
  let fromClean = null;

  // ===================================================
  // ✅ PRIORIDAD 0: Si YA VIENE EL NÚMERO REAL
  // ===================================================
  if (msg?.key?.remoteJid?.endsWith("@s.whatsapp.net")) {
    const real = msg.key.remoteJid.replace("@s.whatsapp.net", "");

    // Si también existe un LID → guardar mapping
    if (msg?.key?.remoteJidAlt?.endsWith("@lid")) {
      const lid = msg.key.remoteJidAlt.replace("@lid", "");

      // Guardar en memoria
      global.__LID_MEMORY__[lid] = real;

      // Guardar en archivo
      const sessionDir = path.join(__dirname, "..", "auth", sessionId, "lids");

      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const reverseMapPath = path.join(
        sessionDir,
        `lid-mapping-${lid}_reverse.json`
      );

      if (!fs.existsSync(reverseMapPath)) {
        fs.writeFileSync(reverseMapPath, real);
        logger.info("✅ Reverse LID mapping creado automáticamente", {
          lid,
          real,
          reverseMapPath,
          sessionId,
        });
      }
    }

    logger.info("✅ Número real tomado directamente de remoteJid", {
      real,
      sessionId,
    });

    return real;
  }

  // ===================================================
  // ✅ PRIORIDAD 1: Si alt ya trae el número real
  // ===================================================
  if (msg?.key?.remoteJidAlt?.endsWith("@s.whatsapp.net")) {
    const clean = msg.key.remoteJidAlt.replace("@s.whatsapp.net", "");

    logger.info("✅ Número directo vía remoteJidAlt", {
      original: msg.key.remoteJidAlt,
      clean,
      sessionId,
    });

    return clean;
  }

  if (msg?.key?.participantAlt?.endsWith("@s.whatsapp.net")) {
    const clean = msg.key.participantAlt.replace("@s.whatsapp.net", "");

    logger.info("✅ Número directo vía participantAlt", {
      original: msg.key.participantAlt,
      clean,
      sessionId,
    });

    return clean;
  }

  if (fromRaw && fromRaw.endsWith("@s.whatsapp.net")) {
    const clean = fromRaw.replace("@s.whatsapp.net", "");

    logger.info("✅ Número directo vía fromRaw", {
      fromRaw,
      clean,
      sessionId,
    });

    return clean;
  }

  // ===================================================
  // 📌 Seleccionar mejor JID candidato
  // ===================================================
  const candidateJid =
    msg?.key?.remoteJidAlt ||
    msg?.key?.participantAlt ||
    msg?.key?.participant ||
    fromRaw;

  // ===================================================
  // 📍 Intentar normalizar con Baileys
  // ===================================================
  try {
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
    logger.warn("⚠️ jidNormalizedUser falló", {
      candidateJid,
      error: e.message,
      sessionId,
    });
  }

  // ===================================================
  // 📍 Si es LID → intentar resolver
  // ===================================================
  if (/@lid$/i.test(candidateJid)) {
    const lid = candidateJid.replace(/@lid$/i, "");

    // 🧠 1) Revisar memoria
    if (global.__LID_MEMORY__[lid]) {
      const real = global.__LID_MEMORY__[lid];

      logger.info("✅ LID resuelto desde memoria temporal", {
        lid,
        real,
        sessionId,
      });

      return real;
    }

    // 📁 2) Revisar archivo
    const sessionDir = path.join(__dirname, "..", "auth", sessionId, "lids");
    const reverseMapPath = path.join(
      sessionDir,
      `lid-mapping-${lid}_reverse.json`
    );

    try {
      if (fs.existsSync(reverseMapPath)) {
        const content = fs.readFileSync(reverseMapPath, "utf8").trim();

        let phone;
        try {
          phone = JSON.parse(content);
        } catch {
          phone = content.replace(/[^0-9]/g, "");
        }

        if (phone) {
          global.__LID_MEMORY__[lid] = phone;

          logger.info("✅ Remitente resuelto desde archivo LID", {
            lid,
            phone,
            reverseMapPath,
            sessionId,
          });

          return phone;
        }
      }

      logger.warn("⚠️ Reverse LID mapping no encontrado", {
        reverseMapPath,
        lid,
        sessionId,
      });
    } catch (e) {
      logger.error("❌ Error leyendo/creando reverse LID mapping", {
        error: e.message,
        lid,
        sessionId,
      });
    }
  }

  // ===================================================
  // 📍 Fallback final
  // ===================================================
  fromClean = candidateJid
    ?.replace(/(@s\.whatsapp\.net|@lid)$/i, "")
    ?.replace(/[^0-9]/g, "");

  logger.warn("⚠️ Fallback simple usado, posible número incorrecto", {
    candidateJid,
    fromClean,
    sessionId,
  });

  return fromClean;
}

/**
 * 🔧 Validar si un JID corresponde a usuario (no grupo)
 */
function isValidUserJid(jid) {
  return (
    jid &&
    (jid.endsWith("@s.whatsapp.net") ||
      jid.endsWith("@lid") ||
      jid.includes("@lid"))
  );
}

/**
 * 📋 Lista los mapeos LID detectados
 */
function listLidMappings(sessionId, logger = console) {
  try {
    const lidsDir = path.join(__dirname, "..", "auth", sessionId, "lids");

    if (!fs.existsSync(lidsDir)) {
      logger.warn("⚠️ Carpeta lids/ no existe para la sesión", {
        sessionId,
        lidsDir,
      });
      return [];
    }

    const files = fs.readdirSync(lidsDir);

    const mappings = files
      .filter(
        (f) => f.startsWith("lid-mapping-") && f.endsWith("_reverse.json")
      )
      .map((f) => {
        const lid = f.replace("lid-mapping-", "").replace("_reverse.json", "");
        const filePath = path.join(lidsDir, f);

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
          logger.error("❌ Error leyendo archivo reverse LID", {
            error: e.message,
            filePath,
          });
          return null;
        }
      })
      .filter(Boolean);

    logger.info("📋 LID mappings encontrados", {
      count: mappings.length,
      sessionId,
    });

    return mappings;
  } catch (e) {
    logger.error("❌ Error listando LID mappings", {
      error: e.message,
      sessionId,
    });
    return [];
  }
}

module.exports = {
  resolveLid,
  isValidUserJid,
  listLidMappings,
};
