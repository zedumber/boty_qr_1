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

  // 📊 Redis
  // redisHost: process.env.REDIS_HOST || "localhost",
  // redisHost: process.env.REDIS_HOST || "redis_saas",
  redisHost: 'redis_saas', // nombre del servicio Docker
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
};
