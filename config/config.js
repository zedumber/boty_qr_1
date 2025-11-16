/**
 * ⚙️ Configuración centralizada del servidor
 */

module.exports = {
  // 🌐 API de Laravel
  // laravelApi: process.env.LARAVEL_API || "http://localhost:8000/api",
  // laravelApi: "https://botyqr.tecsolbd.com/api",
  laravelApi: "http://boty_qr_back:8005/api",

  // 🔌 Servidor Node
  port: process.env.PORT || 4000,

  // 📊 Redis - Escalable para 200+ usuarios
  // En producción: usar Redis Cluster o Sentinel para HA
  redisHost: "redis_saas", // nombre del servicio Docker
  // redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: process.env.REDIS_PORT || 6379,
  redisMaxRetriesPerRequest: null, // crítico para Bull/colas
  redisEnableReadyCheck: false, // mejora throughput
  redisEnableOfflineQueue: true,
  redisDb: process.env.REDIS_DB || 0,

  // 🚦 Configuración de colas - Optimizada para 200+ usuarios
  // Mensajes: 20 workers concurrentes para procesar en paralelo
  maxConcurrentMessages: process.env.MAX_CONCURRENT_MESSAGES || 20,

  // QR: cola separada para generar QRs sin bloquear mensajes
  maxConcurrentQrGeneration: process.env.MAX_CONCURRENT_QR || 10,

  // Timeouts
  messageProcessingTimeout: 45000, // 45s (aumentado de 30s)
  qrGenerationTimeout: 30000, // 30s para generar QR
  pendingSessionTimeout: process.env.PENDING_SESSION_TIMEOUT || 120000, // 2 minutos - eliminar sesiones pending sin respuesta

  // Reintentos con backoff exponencial
  messageMaxRetries: process.env.MESSAGE_MAX_RETRIES || 5,
  messageRetryDelay: 3000, // 3s base para backoff

  // Circuit Breaker - Protección contra sobrecarga (pero más tolerante en producción)
  // En producción con mucho tráfico, subir a 20-30 fallos antes de abrir
  circuitBreakerThreshold: process.env.CIRCUIT_BREAKER_THRESHOLD || 20,
  circuitBreakerResetTimeout: process.env.CIRCUIT_BREAKER_RESET || 180000, // 3 minutos en producción

  // 🧹 Limpieza de recursos
  audioCleanupInterval: 15 * 60 * 1000, // 15 minutos
  audioMaxAge: 3600 * 1000, // 1 hora
  oldJobsCleanupInterval: 60 * 60 * 1000, // 1 hora

  // 📊 Límites de sesiones y memoria
  maxActiveSessions: process.env.MAX_ACTIVE_SESSIONS || 250, // 250 sesiones máximo
  sessionIdleTTL: 24 * 3600 * 1000, // 24 horas: sesión idle se limpia
  sessionMaxLifetime: 7 * 24 * 3600 * 1000, // 7 días: renovar credenciales
  pendingSessionCleanupInterval: process.env.PENDING_CLEANUP_INTERVAL || 30000, // 30s - verificar y eliminar pending cada 30s

  // 📡 HTTP Client - Escalado para 200+ usuarios
  httpTimeout: 20000, // 20s (aumentado)
  httpMaxSockets: 500, // 500 conexiones simultáneas (de 200)
  httpMaxFreeSockets: 50, // 50 sockets libres (de 20)
  httpFreeSocketTimeout: 60000, // 60s timeout libre (aumentado)

  // Keep-Alive agresivo para reutilizar conexiones
  httpKeepAliveTimeout: 30000, // 30s entre keep-alives
  httpKeepAliveMaxTimeout: 120000, // 2 minutos máximo
};
