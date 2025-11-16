# 🚀 Guía de Escalabilidad: 200+ Usuarios Simultáneos

## 📊 Arquitectura Optimizada

El sistema ha sido reconfigurado para soportar **200+ usuarios simultáneos** con las siguientes mejoras:

### 1. **Colas Paralelas y Separadas**

- **Cola de Mensajes** (`whatsapp-messages`): 20 workers concurrentes
- **Cola de QR** (`qr-generation`): 10 workers dedicados
- Ambas colas operan en **paralelo sin interferencias**

```javascript
// Configuración en config.js
maxConcurrentMessages: 20,      // Procesa 20 mensajes en paralelo
maxConcurrentQrGeneration: 10,  // Procesa 10 QRs en paralelo
```

### 2. **Circuit Breaker Mejorado**

- Umbral de fallos: **10** (de 5 antes)
- Timeout de reset: **120 segundos** (de 60)
- Backoff exponencial adaptativo
- Recuperación inteligente después de picos

### 3. **Gestión de Sesiones con TTL**

```javascript
maxActiveSessions: 250,              // Máximo 250 sesiones en memoria
sessionIdleTTL: 24 * 3600 * 1000,   // Limpiar después de 24h inactivas
sessionMaxLifetime: 7 * 24 * 3600 * 1000  // Renovar cada 7 días
```

- **Limpieza automática** cada 60 minutos de sesiones inactivas
- Previene fuga de memoria con usuarios fantasma

### 4. **Conexiones HTTP Escaladas**

```javascript
httpMaxSockets: 500,        // 500 conexiones simultáneas (de 200)
httpMaxFreeSockets: 50,     // 50 sockets reutilizables (de 20)
httpFreeSocketTimeout: 60000 // 60s antes de descartar socket libre
```

- **Keep-Alive agresivo** para reutilizar conexiones
- Reduce latencia de handshake TLS

### 5. **Reintentos Adaptivos**

```javascript
messageMaxRetries: 5,           // 5 reintentos máximos
messageRetryDelay: 3000,        // 3 segundos base (exponencial)
messageProcessingTimeout: 45000 // 45s timeout (de 30s)
```

---

## 🖥️ Requisitos de Hardware

### **Mínimo (100-150 usuarios)**

- **CPU**: 4 cores
- **RAM**: 8 GB
- **Redis**: 2 GB de memoria
- **Ancho de banda**: 10 Mbps

### **Recomendado (150-300 usuarios)**

- **CPU**: 8+ cores (Intel Xeon o equivalente)
- **RAM**: 16 GB mínimo, 32 GB ideal
- **Redis**: 5-8 GB de memoria (Cluster recomendado)
- **Almacenamiento**: SSD de 256 GB
- **Ancho de banda**: 50 Mbps+

### **Producción (300+ usuarios)**

- **CPU**: 16+ cores con múltiples servidores
- **RAM**: 32-64 GB por nodo
- **Redis**: Redis Cluster con 3+ nodos
- **Base de datos**: PostgreSQL con replicación
- **Load Balancer**: Nginx/HAProxy con SSL
- **CDN**: CloudFlare o Akamai para multimedia

---

## 📡 Infraestructura de Redis

### **Desarrollo Local**

```bash
# Docker local
docker run -d -p 6379:6379 --name redis redis:7-alpine

# Verificar
redis-cli ping  # Responde PONG
```

### **Staging (10-50 usuarios)**

```bash
# Redis Sentinel para HA (3 nodos)
docker-compose up -d  # Ver docker-compose.yml

# Credenciales
export REDIS_HOST=localhost
export REDIS_PORT=26379  # Sentinel port
```

### **Producción (200+ usuarios)**

**Opción A: Redis Cluster (Recomendado)**

```bash
# 6 nodos (3 master + 3 replica)
redis-cli --cluster create \
  192.168.1.100:6379 \
  192.168.1.101:6379 \
  192.168.1.102:6379 \
  192.168.1.103:6379 \
  192.168.1.104:6379 \
  192.168.1.105:6379 \
  --cluster-replicas 1

# Configurar en app
export REDIS_CLUSTER=true
export REDIS_NODES=192.168.1.100:6379,192.168.1.101:6379,...
```

**Opción B: Redis Sentinel + Master/Replica**

```bash
# Master: 192.168.1.100:6379
# Replica 1: 192.168.1.101:6379
# Replica 2: 192.168.1.102:6379
# Sentinel: 3 instancias en puertos 26379

export REDIS_SENTINEL=true
export REDIS_SENTINEL_URLS=192.168.1.100:26379,192.168.1.101:26379,...
```

---

## 🔄 Balanceo de Carga

### **Nginx Configuration**

```nginx
upstream botyqr_backend {
    least_conn;  # Round-robin con menos conexiones

    server node1.internal:4000 max_fails=2 fail_timeout=10s;
    server node2.internal:4000 max_fails=2 fail_timeout=10s;
    server node3.internal:4000 max_fails=2 fail_timeout=10s;
    server node4.internal:4000 max_fails=2 fail_timeout=10s;
}

server {
    listen 443 ssl http2;
    server_name api.botyqr.com;

    ssl_certificate /etc/ssl/certs/botyqr.crt;
    ssl_certificate_key /etc/ssl/private/botyqr.key;

    location / {
        proxy_pass http://botyqr_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;

        # Timeouts para WebSocket
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 5s;
    }
}
```

---

## 📈 Monitoreo y Métricas

### **Health Check Endpoint**

```bash
curl http://localhost:4000/health

# Respuesta esperada
{
  "status": "OK",
  "timestamp": "2025-11-16T17:04:25.551Z",
  "activeSessions": 3,
  "queues": {
    "messageQueue": { "active": 5, "waiting": 12, "completed": 1203 },
    "qrQueue": { "active": 2, "waiting": 3, "completed": 450 }
  },
  "circuitBreaker": {
    "state": "CLOSED",
    "failureCount": 0,
    "successCount": 42
  }
}
```

### **Prometheus Metrics (Opcional)**

```javascript
// Instalar
npm install prom-client

// En index.js
const prometheus = require('prom-client');

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prometheus.register.contentType);
  res.end(await prometheus.register.metrics());
});
```

---

## 🚀 Despliegue con PM2

### **Configuración Cluster Mode**

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "botyqr",
      script: "./index.js",
      instances: 4, // 4 procesos (1 por core recomendado)
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production",
        PORT: 4000,
        REDIS_HOST: "redis.internal",
        MAX_CONCURRENT_MESSAGES: 20,
        MAX_CONCURRENT_QR: 10,
      },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_memory_restart: "1G", // Reiniciar si usa >1GB
      watch: false,
      ignore_watch: ["node_modules", "logs", "auth"],
      merge_logs: true,
    },
  ],
};
```

**Iniciar**:

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 monit  # Monitorear en tiempo real
pm2 logs botyqr --lines 100  # Ver logs
```

---

## 🔐 Seguridad en Producción

### **Variables de Entorno**

```bash
# .env
NODE_ENV=production
PORT=4000
LARAVEL_API=https://api.example.com
REDIS_HOST=redis.internal
REDIS_PORT=6379
REDIS_PASSWORD=tu_contraseña_segura
MAX_CONCURRENT_MESSAGES=20
MAX_CONCURRENT_QR=10
CIRCUIT_BREAKER_THRESHOLD=10
CIRCUIT_BREAKER_RESET=120000
```

### **Rate Limiting**

```javascript
// npm install express-rate-limit
const rateLimit = require("express-rate-limit");

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // 100 requests por IP
  message: "Demasiadas solicitudes, intenta más tarde",
  standardHeaders: true,
});

app.use("/api/", limiter);
```

---

## 📊 Escalabilidad Esperada

| Métrica                    | 100 usuarios | 200 usuarios | 300+ usuarios |
| -------------------------- | ------------ | ------------ | ------------- |
| **Memoria RAM**            | 4-6 GB       | 12-16 GB     | 32 GB+        |
| **Conexiones simultáneas** | 150          | 300          | 500+          |
| **Mensajes/segundo**       | 10-20        | 30-50        | 100+          |
| **Latencia p95**           | <500ms       | <800ms       | <1.5s         |
| **CPU**                    | 30-40%       | 50-70%       | 75-90%        |
| **Redis Memory**           | 1-2 GB       | 4-6 GB       | 10+ GB        |

---

## 🧪 Testing de Carga

```bash
# Instalar Apache Bench
# macOS
brew install httpd

# Ubuntu
sudo apt-get install apache2-utils

# Test: 1000 requests, 50 concurrentes
ab -n 1000 -c 50 http://localhost:4000/health

# Resultado esperado
Requests per second: 100+
Time per request: <10ms
Failed requests: 0
```

---

## 🆘 Troubleshooting

### **Síntomas: Baja throughput (< 10 msg/sec)**

1. Verificar Redis: `redis-cli INFO stats`
2. Aumentar `maxConcurrentMessages` a 30-40
3. Reducir `messageProcessingTimeout` si es seguro
4. Escalar Redis a múltiples instancias

### **Síntomas: Memory leak (RAM sube continuamente)**

1. Revisar `sessionIdleTTL` - aumentar a 12h si hay picos
2. Verificar `queueManager.cleanOldJobs()` se ejecuta
3. Monitorear sesiones: `curl http://localhost:4000/sessions`
4. Implementar graceful shutdown en K8s

### **Síntomas: Circuit Breaker abierto frecuentemente**

1. Aumentar `circuitBreakerThreshold` a 15-20
2. Aumentar `circuitBreakerResetTimeout` a 180s
3. Revisar logs de Laravel API para errores 500
4. Escalar servidores backend

---

## 📚 Referencias

- [Bull Queue Documentation](https://github.com/OptimalBits/bull)
- [Redis Cluster](https://redis.io/topics/cluster-tutorial)
- [Node.js Performance](https://nodejs.org/en/docs/guides/nodejs-performance/)
- [PM2 Cluster Mode](https://pm2.keymetrics.io/docs/usage/cluster-mode/)

---

**Última actualización**: Nov 16, 2025  
**Versión**: 2.0 (200+ Ready)
