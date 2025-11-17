/**
 * 🛠️ Utilidades Compartidas - WhatsApp Manager
 *
 * Métodos comunes reutilizables entre todos los managers
 * Evita duplicidad de código
 */

/**
 * ⏱️ Helper para dormir
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 🌐 Envía datos a Laravel con reintentos automáticos
 *
 * Parámetros:
 * - axios: cliente HTTP configurado
 * - laravelApi: base URL de la API (ej: http://localhost:8000/api)
 * - logger: instancia de logger
 * - path: endpoint (ej: /qr, /whatsapp/status)
 * - body: datos a enviar
 * - attempts: número máximo de reintentos (default: 3)
 * - backoffBase: base para backoff exponencial (default: 600)
 * - backoffJitter: jitter aleatorio (default: 400)
 */
async function postLaravel(
  axios,
  laravelApi,
  logger,
  path,
  body,
  options = {}
) {
  const { attempts = 3, backoffBase = 600, backoffJitter = 400 } = options;

  let tryNum = 0;

  while (true) {
    tryNum++;
    try {
      return await axios.post(`${laravelApi}${path}`, body);
    } catch (e) {
      const status = e?.response?.status;
      const retriable =
        status === 429 || (status >= 500 && status < 600) || !status;

      if (!retriable || tryNum >= attempts) {
        throw e;
      }

      const backoff =
        backoffBase * Math.pow(2, tryNum - 1) +
        Math.floor(Math.random() * backoffJitter);

      logger.warn(`🔄 Retry ${tryNum}/${attempts} ${path}`, {
        status: status || "network",
        backoff,
      });

      await sleep(backoff);
    }
  }
}

/**
 * 🔍 Obtiene el estado del QR en Laravel
 *
 * Retorna: estado_qr (pending, active, inactive, etc.)
 */
async function getQrStatus(axios, laravelApi, logger, sessionId) {
  try {
    const { data } = await axios.get(
      `${laravelApi}/whatsapp/status/${sessionId}`
    );
    return data?.estado_qr;
  } catch (error) {
    logger.error("❌ Error obteniendo estado QR", error, { sessionId });
    throw error;
  }
}

/**
 * ✅ Verifica si una sesión está activa en Laravel
 *
 * Retorna: true si existe y tiene estado, false en caso contrario
 */
async function isSessionActive(axios, laravelApi, logger, sessionId) {
  try {
    const estado = await getQrStatus(axios, laravelApi, logger, sessionId);
    return !!estado;
  } catch (err) {
    logger.error("❌ Error verificando sessionId en Laravel", err, {
      sessionId,
    });
    return false;
  }
}

module.exports = {
  sleep,
  postLaravel,
  getQrStatus,
  isSessionActive,
};
