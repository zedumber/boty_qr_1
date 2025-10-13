# ⚡ Quick Start Guide

## 🚀 Inicio Rápido en 5 Minutos

### 1️⃣ Configurar (1 minuto)

```powershell
# Abrir configuración
notepad config\config.js
```

**Ajustar solo estas 3 líneas:**

```javascript
laravelApi: "http://localhost:8000/api",  // Tu Laravel API
redisHost: 'localhost',                    // 'localhost' o 'redis' en Docker
port: 4000                                 // Puerto del servidor
```

### 2️⃣ Instalar Dependencias (1 minuto)

```powershell
npm install
```

### 3️⃣ Iniciar Servidor (1 minuto)

```powershell
node index_new.js
```

**Deberías ver:**

```json
{
  "timestamp": "2025-10-05T...",
  "level": "INFO",
  "message": "🚀 Servidor iniciado correctamente",
  "port": 4000
}
```

### 4️⃣ Verificar Funcionamiento (1 minuto)

```powershell
# En otra terminal
curl http://localhost:4000/health
```

**Deberías ver:**

```json
{
  "status": "OK",
  "uptime": 10,
  "activeSessions": 0
}
```

### 5️⃣ Crear Primera Sesión (1 minuto)

```powershell
curl -X POST http://localhost:4000/start `
  -H "Content-Type: application/json" `
  -d '{"user_id":"test-123"}'
```

**Deberías ver:**

```json
{
  "success": true,
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

## ✅ ¡Listo!

Tu servidor está corriendo. Ahora:

1. **Laravel debe llamar al endpoint para obtener el QR**
2. **Usuario escanea el QR con WhatsApp**
3. **Sistema cambia a estado "active"**
4. **Ya puedes enviar/recibir mensajes**

---

## 📖 Siguiente Paso

Lee los documentos según tu necesidad:

- 🏃 **Uso rápido**: `EXAMPLES.md`
- 🏗️ **Entender arquitectura**: `ARCHITECTURE.md`
- 📊 **Ver diferencias**: `COMPARISON.md`
- 📚 **Guía completa**: `README.md`

---

## 🆘 Solución Rápida de Problemas

### ❌ Error: "Cannot find module"

```powershell
npm install
```

### ❌ Error: "Redis connection failed"

```powershell
# Asegúrate de que Redis esté corriendo
redis-server

# O en Docker
docker-compose up redis
```

### ❌ Error: "Port 4000 already in use"

```javascript
// En config/config.js cambiar:
port: 4001; // O el puerto que quieras
```

### ❌ LIDs no se resuelven

```powershell
# Ver logs detallados
node index_new.js | jq 'select(.message | contains("LID"))'
```

---

## 📞 Comandos Útiles

```powershell
# Ver logs estructurados
node index_new.js | jq .

# Solo errores
node index_new.js 2>&1 | jq 'select(.level == "ERROR")'

# Health check
curl http://localhost:4000/health | jq .

# Listar sesiones
curl http://localhost:4000/sessions | jq .

# Info de sesión específica
curl http://localhost:4000/session/{SESSION_ID} | jq .
```

---

## 🎯 Test Rápido Completo

```powershell
# 1. Crear sesión
$SESSION = (curl -s -X POST http://localhost:4000/start `
  -H "Content-Type: application/json" `
  -d '{"user_id":"test"}' | ConvertFrom-Json).session_id

Write-Host "Session ID: $SESSION"

# 2. Ver info de la sesión
curl http://localhost:4000/session/$SESSION | jq .

# 3. Esperar a escanear QR en Laravel...

# 4. Enviar mensaje de prueba
curl -X POST http://localhost:4000/send-message `
  -H "Content-Type: application/json" `
  -d "{
    \"session_id\": \"$SESSION\",
    \"wa_id\": \"573001234567\",
    \"type\": \"text\",
    \"body\": \"Test desde PowerShell\"
  }"
```

---

## 🐳 Quick Start con Docker

```powershell
# 1. Construir imagen
docker build -t whatsapp-server .

# 2. Iniciar con docker-compose
docker-compose up -d

# 3. Ver logs
docker-compose logs -f whatsapp-server

# 4. Health check
curl http://localhost:4000/health
```

---

## 🎓 Tips

1. **Logs**: Siempre revisa los logs JSON, tienen toda la info
2. **LIDs**: Busca en logs mensajes con "resuelto" o "resolver"
3. **Health**: Usa `/health` para ver métricas en tiempo real
4. **Config**: Todos los ajustes están en `config/config.js`

---

**¿Listo?** Ejecuta:

```powershell
node index_new.js
```

**¡A trabajar!** 🚀
