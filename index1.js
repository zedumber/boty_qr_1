/**
 * 🚀 Servidor Node.js para manejar sesiones de WhatsApp con Baileys - VERSIÓN ROBUSTA
 * Integración con Laravel API
 */

const express = require("express");
const axios = require("axios");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadContentFromMessage,
    jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const https = require("https");
const http = require("http");
const Queue = require('bull');
const Redis = require('ioredis');

// 📌 Configuración
const LARAVEL_API = "http://localhost:8000/api";
// const LARAVEL_API = "https://botyqr.tecsolbd.com/api"; // tu backend Laravel
// const LARAVEL_API = "http://boty_qr_back:8030/api";
const PORT = 4000;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
// const REDIS_HOST = process.env.REDIS_HOST || 'redis_saas'; // nombre del servicio Docker
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// 🔧 Configuración de robustez
const QR_THROTTLE_MS = 30_000;
const QR_EXPIRES_MS = 60_000;
const MAX_QR_RETRIES = 3;
const BACKOFF_BASE = 600;
const BACKOFF_JITTER = 400;
const MESSAGE_PROCESSING_TIMEOUT = 30000;
const MAX_CONCURRENT_MESSAGES = 5;

// 📦 Estado global por sesión
const qrTimeouts = {};
const lastQrSent = new Map();
const lastQrAt = new Map();
const inflightQr = new Map();
const sessions = {};

// 🔄 Configuración de Redis para colas
const redisConfig = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false
};

// 🚦 Crear colas para procesamiento
const messageQueue = new Queue('whatsapp-messages', { redis: redisConfig });
const qrQueue = new Queue('qr-processing', { redis: redisConfig });

// 🌀 Circuit Breaker para evitar sobrecargar servicios
class CircuitBreaker {
    constructor(failureThreshold = 5, resetTimeout = 60000) {
        this.failureThreshold = failureThreshold;
        this.resetTimeout = resetTimeout;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED';
    }

    async execute(callback) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.resetTimeout) {
                this.state = 'HALF_OPEN';
            } else {
                throw new Error('Circuit breaker is OPEN');
            }
        }

        try {
            const result = await callback();
            if (this.state === 'HALF_OPEN') {
                this.state = 'CLOSED';
                this.failureCount = 0;
            }
            return result;
        } catch (error) {
            this.failureCount++;
            this.lastFailureTime = Date.now();

            if (this.failureCount >= this.failureThreshold) {
                this.state = 'OPEN';
            }

            throw error;
        }
    }
}

// Crear instancias de circuit breakers
const laravelCircuitBreaker = new CircuitBreaker(5, 60000);

// 📊 Sistema de métricas de rendimiento
// 📊 Sistema de métricas de rendimiento
const performanceMetrics = {
    messagesProcessed: 0,
    messagesFailed: 0,
    avgProcessingTime: 0,
    startTimes: new Map(),

    startMessage(id) {
        this.startTimes.set(id, Date.now());
    },

    async endMessage(id, success = true) {
        const startTime = this.startTimes.get(id);
        if (!startTime) return;

        const processingTime = Date.now() - startTime;
        this.avgProcessingTime =
            (this.avgProcessingTime * this.messagesProcessed + processingTime) /
            (this.messagesProcessed + 1);

        if (success) {
            this.messagesProcessed++;
        } else {
            this.messagesFailed++;
        }

        this.startTimes.delete(id);

        // Loggear métricas cada 100 mensajes
        if (this.messagesProcessed % 100 === 0) {
            try {
                const queueSize = messageQueue ? await messageQueue.count() : 0;
                logger.info('Métricas de rendimiento', {
                    messagesProcessed: this.messagesProcessed,
                    messagesFailed: this.messagesFailed,
                    avgProcessingTime: this.avgProcessingTime,
                    queueSize
                });
            } catch (err) {
                logger.error('Error obteniendo tamaño de la cola', err);
            }
        }
    }
};


// 📝 Logger estructurado
const logger = {
    info: (message, meta = {}) => {
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            message,
            ...meta
        }));
    },
    error: (message, error = null, meta = {}) => {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message,
            error: error ? error.message : null,
            stack: error ? error.stack : null,
            ...meta
        }));
    },
    warn: (message, meta = {}) => {
        console.warn(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'WARN',
            message,
            ...meta
        }));
    }
};

// Axios con keep-alive para alto volumen
const axiosHttp = axios.create({
    httpAgent: new http.Agent({
        keepAlive: true,
        maxSockets: 200,
        maxFreeSockets: 20,
        timeout: 60000,
        freeSocketTimeout: 30000
    }),
    httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 200,
        maxFreeSockets: 20,
        timeout: 60000,
        freeSocketTimeout: 30000
    }),
    timeout: 15000,
});

// Interceptor para reintentos
axiosHttp.interceptors.response.use(null, async (error) => {
    const config = error.config;

    if (!config || !config.retry) {
        config.retry = 0;
    }

    config.retryCount = config.retryCount || 0;
    const maxRetries = config.maxRetries || 3;

    if (config.retryCount >= maxRetries) {
        return Promise.reject(error);
    }

    config.retryCount += 1;

    // Retry con backoff exponencial
    const delay = Math.pow(2, config.retryCount) * 1000;
    await new Promise(resolve => setTimeout(resolve, delay));

    return axiosHttp(config);
});

// 🔄 Funciones de utilidad
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Función robusta para enviar datos a Laravel
async function postLaravel(path, body, attempts = MAX_QR_RETRIES) {
    let tryNum = 0;
    while (true) {
        tryNum++;
        try {
            return await laravelCircuitBreaker.execute(() =>
                axiosHttp.post(`${LARAVEL_API}${path}`, body)
            );
        } catch (e) {
            const status = e?.response?.status;
            const retriable = status === 429 || (status >= 500 && status < 600) || !status;
            if (!retriable || tryNum >= attempts) throw e;

            const backoff = BACKOFF_BASE * Math.pow(2, tryNum - 1) + Math.floor(Math.random() * BACKOFF_JITTER);
            logger.warn(`Retry ${tryNum}/${attempts} ${path}`, { status: status || 'network', backoff });
            await sleep(backoff);
        }
    }
}

// Lee estado_qr actual en Laravel
async function getQrStatus(sessionId) {
    try {
        const { data } = await axiosHttp.get(`${LARAVEL_API}/whatsapp/status/${sessionId}`);
        return data?.estado_qr;
    } catch (error) {
        logger.error('Error obteniendo estado QR', error, { sessionId });
        throw error;
    }
}

// 🌀 Procesador de mensajes para la cola
async function processMessageJob(job) {
    const { msgUpdate, sessionId } = job.data;
    const msg = msgUpdate.messages[0];
    const messageId = msg.key.id;

    performanceMetrics.startMessage(messageId);

    try {
        logger.info('Procesando mensaje desde cola', { jobId: job.id, messageId, sessionId });

        const sock = sessions[sessionId];
        if (!sock) {
            throw new Error(`Socket no encontrado para sessionId: ${sessionId}`);
        }

        if (!msg.message) {
            logger.warn('Mensaje sin contenido, ignorando', { messageId });
            return { success: true, skipped: true };
        }

        if (msg.key.fromMe) {
            logger.warn('Mensaje propio, ignorando', { messageId });
            return { success: true, skipped: true };
        }

        const fromRaw = msg.key.remoteJid;
        let fromClean = null;

        try {
            // Preferir remoteJidAlt si está disponible (mejor fuente para LID)
            const candidateJid = msg.key.remoteJidAlt || fromRaw;
            const normalized = jidNormalizedUser(candidateJid);
            if (normalized && /@s\.whatsapp\.net$/i.test(normalized)) {
                fromClean = normalized.replace(/@s\.whatsapp\.net$/i, "");
                logger.info('Remitente normalizado vía jidNormalizedUser', { candidateJid, normalized, fromClean });
            }
        } catch (e) {
            logger.warn('jidNormalizedUser falló, continuando con fallback', { fromRaw, sessionId });
        }

        // Fallback: resolver desde archivos de mapeo locales (lid-mapping-*_reverse.json)
        if (!fromClean && /@lid$/i.test(fromRaw)) {
            try {
                const lid = fromRaw.replace(/@lid$/i, "");
                const sessionDir = path.join(__dirname, 'auth', sessionId);
                const reverseMapPath = path.join(sessionDir, `lid-mapping-${lid}_reverse.json`);
                if (fs.existsSync(reverseMapPath)) {
                    const content = fs.readFileSync(reverseMapPath, 'utf8').trim();
                    // El archivo contiene un string JSON con el número, ej: "57300..."
                    const phone = (() => { try { return JSON.parse(content); } catch { return content.replace(/[^0-9]/g, ''); } })();
                    if (phone) {
                        fromClean = String(phone);
                        logger.info('Remitente resuelto desde reverse LID mapping', { lid, fromClean });
                    }
                }
            } catch (e) {
                logger.error('Error leyendo reverse LID mapping', e, { fromRaw, sessionId });
            }
        }

        if (!(fromRaw.endsWith("@s.whatsapp.net") || fromRaw.endsWith("@lid"))) {
            logger.warn('Mensaje descartado por tipo de remitente', { fromRaw });
            return { success: true, skipped: true };
        }

        // Si aún no se pudo resolver, como último recurso usar el JID limpio directamente
        if (!fromClean) {
            fromClean = fromRaw.replace(/(@s\.whatsapp\.net|@lid)$/i, "");
            logger.warn('Usando remitente sin resolver (fallback simple)', { fromRaw, fromClean });
        }

        const pushName = msg.pushName || fromClean;

        let type = "text";
        let text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            "";

        let filename = null;

        // 🔊 Manejar audio
        if (msg.message.audioMessage) {
            const audioMsg = msg.message.audioMessage;
            const mime = audioMsg.mimetype;
            const ext = mime.split("/")[1].split(";")[0] || "ogg";

            if (!fs.existsSync("./audios")) {
                fs.mkdirSync("./audios", { recursive: true });
            }

            const stream = await downloadContentFromMessage(audioMsg, "audio");
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            filename = `./audios/${fromClean}_${msg.key.id}.${ext}`;
            fs.writeFileSync(filename, buffer);

            text = "[Mensaje de audio]";
            type = "audio";
            logger.info('Audio guardado', { filename, sessionId });
        }

        logger.info('Nuevo mensaje recibido', { fromClean, pushName, type, sessionId });

        // 📤 Enviar a Laravel
        const { data } = await axiosHttp.get(`${LARAVEL_API}/whatsapp/account/${sessionId}`);
        const accountToken = data.webhook_token;

        const form = new FormData();
        form.append("from", fromClean);
        form.append("text", text);
        form.append("type", type);
        form.append("wamId", msg.key.id);
        form.append("timestamp", msg.messageTimestamp);
        form.append("pushName", pushName);

        if (filename) {
            form.append("audio", fs.createReadStream(filename));
        }

        await axiosHttp.post(`${LARAVEL_API}/whatsapp-webhook/${accountToken}`, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
        });

        logger.info('Mensaje enviado a Laravel', { fromClean, messageId, sessionId });
        performanceMetrics.endMessage(messageId, true);

        return { success: true, messageId };
    } catch (error) {
        logger.error('Error procesando mensaje', error, { messageId, sessionId });
        performanceMetrics.endMessage(messageId, false);
        throw error;
    }
}

// 🔄 Configurar procesadores de cola
messageQueue.process(MAX_CONCURRENT_MESSAGES, async (job) => {
    return await processMessageJob(job);
});

// 🚀 Función principal para iniciar sesión
async function startSession(sessionId, userId) {
    logger.info('Iniciando sesión', { sessionId, userId });

    // 📁 Carpeta donde se guardan los archivos de credenciales
    const sessionDir = path.join(__dirname, "auth", sessionId);

    if (!fs.existsSync(sessionDir)) {
        logger.info('Creando directorio de sesión', { sessionDir });
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    // 🔐 Carga/guarda credenciales en archivos JSON
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    // ⚡ Crear socket WhatsApp
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["boty-SaaS", "Chrome", "1.0"],
        printQRInTerminal: false,
    });

    async function isSessionActive(sessionId) {
        try {
            const estado = await getQrStatus(sessionId);
            return !!estado; // true si existe, false si no
        } catch (err) {
            logger.error('Error verificando sessionId en Laravel', err, { sessionId });
            return false;
        }
    }


    /**
     * 📡 Manejo de conexión
     */
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        logger.info('Actualización de conexión', { connection, sessionId });

        // ---------- Manejo de QR (de-dup + throttle + retry) ----------
        if (qr && connection !== "open") {
            const active = await isSessionActive(sessionId);
            if (!active) {
                logger.warn('SessionId inactivo, ignorando QR', { sessionId });
                return;
            }
            const prevQr = lastQrSent.get(sessionId);
            const lastAt = lastQrAt.get(sessionId) || 0;
            const now = Date.now();

            // De-dup: solo si cambió el QR
            const isNewQr = qr !== prevQr;
            // Throttle: máx 1 envío cada QR_THROTTLE_MS
            const canSend = (now - lastAt) >= QR_THROTTLE_MS;

            if (isNewQr && canSend && !inflightQr.get(sessionId)) {
                inflightQr.set(sessionId, true);

                try {
                    logger.info('Nuevo QR generado', { sessionId });
                    await postLaravel("/qr", { session_id: sessionId, qr });
                    await postLaravel("/whatsapp/status", {
                        session_id: sessionId,
                        estado_qr: "pending",
                    });

                    // Marca como enviado y actualiza reloj
                    lastQrSent.set(sessionId, qr);
                    lastQrAt.set(sessionId, now);
                    logger.info('QR enviado y estado actualizado', { sessionId });

                    // ---- Expiración segura por sesión ----
                    if (qrTimeouts[sessionId]) { clearTimeout(qrTimeouts[sessionId]); }
                    qrTimeouts[sessionId] = setTimeout(async () => {
                        try {
                            const estado = await getQrStatus(sessionId);
                            if (estado === "pending") {
                                await postLaravel("/whatsapp/status", {
                                    session_id: sessionId,
                                    estado_qr: "inactive",
                                });
                                logger.info('QR expirado', { sessionId });
                            }
                        } catch (err) {
                            logger.error('Error al expirar QR', err, { sessionId });
                        } finally {
                            delete qrTimeouts[sessionId];
                        }
                    }, QR_EXPIRES_MS);

                } catch (err) {
                    const status = err?.response?.status;
                    logger.error('Error enviando QR/status', err, { sessionId, status });
                } finally {
                    inflightQr.set(sessionId, false);
                }
            } else {
                if (!isNewQr) logger.info('QR duplicado, ignorando', { sessionId });
                else if (!canSend) logger.info('Throttle activo para QR', { sessionId });
                else logger.info('Envío de QR en curso', { sessionId });
            }
        }

        // ---------- Sesión abierta ----------
        if (connection === "open") {
            logger.info('Sesión abierta', { sessionId });

            // Limpieza total de estado de QR
            if (qrTimeouts[sessionId]) { clearTimeout(qrTimeouts[sessionId]); delete qrTimeouts[sessionId]; }
            lastQrSent.delete(sessionId);
            lastQrAt.delete(sessionId);
            inflightQr.delete(sessionId);
            if (await isSessionActive(sessionId)) {
                try {
                    await postLaravel("/whatsapp/status", {
                        session_id: sessionId,
                        estado_qr: "active",
                    });
                    logger.info('Estado actualizado a active', { sessionId });
                } catch (err) {
                    logger.error('Error actualizando estado a active', err, { sessionId });
                }
            }       

            try {
                await postLaravel("/whatsapp/status", {
                    session_id: sessionId,
                    estado_qr: "active",
                });
                logger.info('Estado actualizado a active', { sessionId });
            } catch (err) {
                logger.error('Error actualizando estado a active', err, { sessionId });
            }
        }

        // ---------- Sesión cerrada ----------
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            logger.info('Sesión cerrada', { sessionId, statusCode, loggedOut });

            // Limpieza de QR por seguridad
            if (qrTimeouts[sessionId]) {
                clearTimeout(qrTimeouts[sessionId]);
                delete qrTimeouts[sessionId];
            }
            lastQrSent.delete(sessionId);
            lastQrAt.delete(sessionId);
            inflightQr.delete(sessionId);

            if (loggedOut) {
                // Usuario realmente desconectado → marcar inactive
                try {
                    await postLaravel("/whatsapp/status", {
                        session_id: sessionId,
                        estado_qr: "inactive",
                    });
                    logger.info('Estado actualizado a inactive', { sessionId });
                } catch (err) {
                    logger.error('Error actualizando estado a inactive', err, { sessionId });
                }
                delete sessions[sessionId]; // limpieza de memoria
            } else {
                // Reintentar solo si sessionId sigue activo en Laravel
                const active = await isSessionActive(sessionId);
                if (active) {
                    logger.info('Reintentando conexión', { sessionId });
                    startSession(sessionId, userId);
                } else {
                    logger.warn('SessionId inactivo, no se reintenta conexión', { sessionId });
                }
            }
        }

    });

    // 📩 Manejo de mensajes entrantes con cola
    sock.ev.on("messages.upsert", async (msgUpdate) => {
        try {
            // Agregar a la cola en lugar de procesar inmediatamente
            await messageQueue.add({
                msgUpdate,
                sessionId
            }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000
                },
                timeout: MESSAGE_PROCESSING_TIMEOUT,
                removeOnComplete: true,
                removeOnFail: false
            });

            logger.info('Mensaje agregado a cola', {
                messageId: msgUpdate.messages[0]?.key?.id,
                sessionId
            });
        } catch (error) {
            logger.error('Error agregando mensaje a cola', error, {
                messageId: msgUpdate.messages[0]?.key?.id,
                sessionId
            });
        }
    });

    // 🔄 Guardar credenciales cada vez que cambien
    sock.ev.on("creds.update", saveCreds);

    // 💾 Guardar socket en memoria
    sessions[sessionId] = sock;

    logger.info('Sesión iniciada correctamente', { sessionId });
}

// 🚀 Helper para enviar mensajes con timeout + reintentos
async function sendWithRetry(sock, jid, content, options = {}, retries = 3, timeout = 15000) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await Promise.race([
                sock.sendMessage(jid, content, options),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Timeout superado")), timeout)
                )
            ]);
            return result;
        } catch (err) {
            lastError = err;
            logger.warn(`Error en intento de envío ${attempt}/${retries}`, err, { jid });
            if (attempt < retries) {
                await sleep(2000);
            }
        }
    }
    throw lastError;
}

// 🎯 Inicializar Express
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/**
 * 📤 API: Enviar mensaje desde Laravel
 */
app.post("/send-message", async (req, res) => {
    const { session_id, wa_id, type, body, mediaUrl, caption } = req.body;

    const sock = sessions[session_id];
    if (!sock) {
        return res.status(404).json({
            success: false,
            error: "Sesión no encontrada",
        });
    }

    try {
        const jid = wa_id + "@s.whatsapp.net";
        let response;

        switch (type) {
            case "text":
                const hasUrl = /(https?:\/\/[^\s]+)/.test(body);
                response = await sendWithRetry(sock, jid, {
                    text: body,
                    preview_url: hasUrl
                });
                break;

            case "image":
                response = await sendWithRetry(sock, jid, {
                    image: { url: mediaUrl },
                    caption: caption || "",
                });
                break;
            case "audio":
                response = await sendWithRetry(sock, jid, {
                    audio: { url: mediaUrl },
                    mimetype: "audio/mpeg",
                });
                break;
            case "video":
                response = await sendWithRetry(sock, jid, {
                    video: { url: mediaUrl },
                    caption: caption || "",
                });
                break;
            case "document":
                response = await sendWithRetry(sock, jid, {
                    document: { url: mediaUrl },
                    caption: caption || "",
                });
                break;
            default:
                throw new Error("Tipo de mensaje no soportado: " + type);
        }

        res.json({ success: true, response });
    } catch (err) {
        logger.error('Error enviando mensaje', err, { session_id, wa_id, type });
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

/**
 * 🚀 API: Crear nueva sesión
 */
app.post("/start", async (req, res) => {
    try {
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: "user_id es requerido" });

        const sessionId = uuidv4();
        await startSession(sessionId, user_id);

        return res.json({ session_id: sessionId });
    } catch (err) {
        logger.error('Error creando sesión', err, { user_id: req.body.user_id });
        return res.status(500).json({ error: "No se pudo crear la sesión" });
    }
});

/**
 * ✉️ API rápida para enviar mensaje de texto
 */
app.post("/send", async (req, res) => {
    const { session_id, to, message } = req.body;
    const sock = sessions[session_id];

    if (!sock) return res.status(404).json({ error: "Sesión no encontrada" });

    try {
        await sock.sendMessage(to, { text: message });
        return res.json({ success: true });
    } catch (err) {
        logger.error('Error enviando mensaje rápido', err, { session_id, to });
        return res.status(500).json({ error: "Error enviando mensaje" });
    }
});

/**
 * 📊 Endpoint para monitoreo de salud
 */
app.get("/health", async (req, res) => {
    try {
        const health = {
            status: "OK",
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            sessions: Object.keys(sessions).length,
            messageQueue: await messageQueue.getJobCounts(),
            metrics: {
                messagesProcessed: performanceMetrics.messagesProcessed,
                messagesFailed: performanceMetrics.messagesFailed,
                avgProcessingTime: performanceMetrics.avgProcessingTime
            }
        };

        res.json(health);
    } catch (error) {
        logger.error('Error en health check', error);
        res.status(500).json({ status: "ERROR", error: error.message });
    }
});

/**
 * ♻️ Restaurar sesiones al reiniciar Node
 */
async function restoreSessions() {
    try {
        // Nuevo endpoint que devuelve todas las cuentas activas
        const { data: accounts } = await axiosHttp.get(`${LARAVEL_API}/whatsapp/accounts/active`);

        if (!accounts.length) {
            logger.info("No hay cuentas activas para restaurar");
            return;
        }

        for (const account of accounts) {
            logger.info("Restaurando sesión activa", { accountId: account.id, token: account.webhook_token });
            await startSession(account.webhook_token, null); // clave estable
        }
    } catch (err) {
        logger.error("Error restaurando sesiones", err);
    }
}

/**
 * 🧹 Limpieza de archivos de audio antiguos
 */
function cleanOldAudios() {
    const audioDir = path.join(__dirname, "audios");
    if (!fs.existsSync(audioDir)) return;

    const now = Date.now();
    const files = fs.readdirSync(audioDir);

    for (const file of files) {
        const filePath = path.join(audioDir, file);
        const stats = fs.statSync(filePath);

        if (now - stats.mtimeMs > 3600 * 1000) {
            try {
                fs.unlinkSync(filePath);
                logger.info('Audio antiguo eliminado', { file });
            } catch (err) {
                logger.error('Error eliminando audio', err, { file });
            }
        }
    }
}

// 🔄 Ejecutar limpieza cada 15 minutos
setInterval(cleanOldAudios, 15 * 60 * 1000);

// 🚀 Iniciar servidor
app.listen(PORT, async () => {
    logger.info(`Servidor Node corriendo en http://localhost:${PORT}`);

    // Inicializar conexión a Redis
    const redisClient = new Redis(redisConfig);

    redisClient.on('connect', () => {
        logger.info('Conectado a Redis');
    });

    redisClient.on('error', (err) => {
        logger.error('Error de conexión a Redis', err);
    });

    await restoreSessions();
});

// 🛑 Manejo graceful de shutdown
process.on('SIGTERM', async () => {
    logger.info('Recibido SIGTERM, cerrando gracefulmente');

    // Cerrar colas
    await messageQueue.close();
    await qrQueue.close();

    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('Recibido SIGINT, cerrando gracefulmente');

    // Cerrar colas
    await messageQueue.close();
    await qrQueue.close();

    process.exit(0);
});