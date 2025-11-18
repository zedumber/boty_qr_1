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
 * Este módulo resuelve el JID real usando todas esas fuentes.
 */

const { jidNormalizedUser } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");

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

  // 📌 1. Elegir el mejor JID posible según Baileys 7.x
  //
  // PRIORIZACIÓN:
  // 1) remoteJidAlt        (solo Baileys 7)
  // 2) participantAlt      (cuando viene de grupos)
  // 3) participant         (fallback grupos)
  // 4) fromRaw             (lo que sea que venga)
  const candidateJid =
    msg?.key?.remoteJidAlt ||
    msg?.key?.participantAlt ||
    msg?.key?.participant ||
    fromRaw;

  // 📍 2. Intentar resolver con jidNormalizedUser (solo 7.x soporta LIDs reales)
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
    logger.warn("⚠️ jidNormalizedUser falló, intentando siguiente estrategia", {
      candidateJid,
      error: e.message,
      sessionId,
    });
  }

  // 📍 3. Si llega ya como @s.whatsapp.net, extraerlo directo
  if (/@s\.whatsapp\.net$/i.test(candidateJid)) {
    fromClean = candidateJid.replace(/@s\.whatsapp\.net$/i, "");
    logger.info("✅ Número extraído directamente de candidateJid", {
      candidateJid,
      fromClean,
      sessionId,
    });
    return fromClean;
  }

  // 📍 4. Si es LID (@lid), intentar reverse mapping
  if (/@lid$/i.test(candidateJid)) {
    try {
      const lid = candidateJid.replace(/@lid$/i, "");

      // 📌 Path REAL para Baileys 7.x (carpeta /lids/)
      const sessionDir = path.join(__dirname, "..", "auth", sessionId, "lids");
      const reverseMapPath = path.join(
        sessionDir,
        `lid-mapping-${lid}_reverse.json`
      );

      if (fs.existsSync(reverseMapPath)) {
        const content = fs.readFileSync(reverseMapPath, "utf8").trim();

        let phone;
        try {
          phone = JSON.parse(content);
        } catch {
          phone = content.replace(/[^0-9]/g, "");
        }

        if (phone) {
          fromClean = String(phone);
          logger.info("✅ Remitente resuelto desde LID mapping", {
            lid,
            fromClean,
            reverseMapPath,
            sessionId,
          });
          return fromClean;
        }
      } else {
        logger.warn("⚠️ Reverse LID mapping no encontrado", {
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

  // 📍 5. Fallback final — extraer números del JID
  fromClean = candidateJid.replace(/(@s\.whatsapp\.net|@lid)$/i, "");
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
          logger.error("❌ Error leyendo archivo reverse LID", e, { filePath });
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
    logger.error("❌ Error listando LID mappings", e, { sessionId });
    return [];
  }
}

module.exports = {
  resolveLid,
  isValidUserJid,
  listLidMappings,
};
