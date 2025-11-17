/**
 * ⚙️ Configuración centralizada del servidor
 */

module.exports = {
  // 🌐 API de Laravel
  laravelApi: process.env.LARAVEL_API || "http://boty_qr_back:8005/api",
  // laravelApi: "https://botyqr.tecsolbd.com/api",
  // laravelApi: "http://localhost:8000/api",

  // 🔌 Servidor Node
  port: process.env.PORT || 4000,

  // 📊 Redis
  // redisHost: process.env.REDIS_HOST || "localhost",
  redisHost: process.env.REDIS_HOST || "redis_saas",
  // redisHost: 'redis_saas', // nombre del servicio Docker
  redisPort: process.env.REDIS_PORT || 6379,

  // 🚦 Configuración de colas
  maxConcurrentMessages: 5,
  messageProcessingTimeout: 30000, // 30 segundosdock
  // 🧹 Limpieza
  audioCleanupInterval: 15 * 60 * 1000, // 15 minutos
  audioMaxAge: 3600 * 1000, // 1 hora

  // 📡 HTTP Client
  httpTimeout: 15000, // 15 segundos
  httpMaxSockets: 200,
  httpMaxFreeSockets: 20,
  httpFreeSocketTimeout: 30000,

  // 📦 BATCHING - Reducir carga a Laravel
  batchSize: 50, // Agrupar 50 items por batch
  batchInterval: 5000, // Enviar cada 5 segundos
  priorityInterval: 1000, // High priority cada 1 segundo

  // 💾 CACHE - Reducir consultas a Laravel
  cacheEnabled: true,
  cacheTtl: {
    qr: 60, // 60 segundos
    status: 120, // 120 segundos
    connection: 30, // 30 segundos
    session: 300, // 5 minutos
  },

  // 🎯 QR THROTTLING
  qrThrottleMs: 30000, // 30 segundos entre QR
  qrExpiresMs: 120000, // QR expira en 2 minutos (aumentado)
  maxQrRetries: 3,

  // 🔌 CIRCUIT BREAKER
  circuitBreakerThreshold: 5, // Fallos antes de abrir
  circuitBreakerTimeout: 60000, // 60 segundos de timeout
};
