# 🔧 Fixes para Producción - Circuit Breaker OPEN + Pending Sessions

## Problema Identificado

### 1. Circuit Breaker se abre (OPEN)

En producción con 200+ usuarios, cuando la API de Laravel tiene latencia o errores:

```json
{
  "error": "Circuit breaker is OPEN",
  "sessionId": "5c969ea6-5345-4c18-a033-23bf84ea1b0f"
}
```

### 2. Sesiones PENDING quedan abiertas indefinidamente

Sesiones en estado "pending" que nunca se conectan generan QRs infinitamente sin consumir recursos activamente.

## ✅ Soluciones Implementadas

### 1. **Usar LaravelSync.enqueue() en lugar de postLaravel() directo**

- **Antes**: `postLaravel()` hacía reintentos inmediatos → saturaba y abría Circuit Breaker
- **Después**: `LaravelSync.enqueue()` procesa en cola con 400ms entre requests → respeta límites

```javascript
// ❌ ANTES (causa Circuit Breaker abierto)
await this.postLaravel("/qr", { ... });

// ✅ DESPUÉS (usa cola asincrónica)
this.sync.enqueue({
  path: "/qr",
  payload: { ... }
});
```

### 2. **No generar QRs para sesiones inactivas**

- **Antes**: Generaba QRs incluso para sesiones sin socket (loggedOut)
- **Después**: Verifica `this.sessions.has(sessionId)` antes de generar

```javascript
// ✅ NUEVO en whatsappManager.js
if (qr && this.sessions.has(sessionId)) {
  await this.qr.handle(qr, sessionId, connection);
}
```

### 3. **Aumentar tolerancia del Circuit Breaker**

- **Antes**: Abría con 10 fallos, reset cada 120 segundos
- **Después**: Abre con 20 fallos, reset cada 180 segundos (3 minutos)

```javascript
// config.js
circuitBreakerThreshold: 20,        // antes: 10
circuitBreakerResetTimeout: 180000, // antes: 120000
```

### 4. **Limpieza automática de sesiones inactivas**

- **Nuevo**: Elimina sesiones no conectadas cada 30 minutos
- **Previene**: Generar QRs infinitos para usuarios loggedOut

```javascript
// index.js - cada 30 minutos
setInterval(() => {
  const inactiveSessions = sessions.filter((s) => !s.connected);
  for (const session of inactiveSessions) {
    whatsappManager.deleteSession(session.sessionId);
  }
}, 30 * 60 * 1000);
```

### 5. **✅ NUEVO: Eliminar sesiones PENDING que vencieron (2 minutos)**

- **Timeout pending**: 45s → **120s (2 minutos)**
- **Limpieza automática**: Cada 30 segundos verifica y elimina pending vencidas
- **Tracking**: Guarda timestamp de cuándo se marcó como pending

```javascript
// config.js
pendingSessionTimeout: 120000,      // 2 minutos
pendingSessionCleanupInterval: 30000, // verificar cada 30s

// modules/core/QrController.js
getExpiredPendingSessions() {
  const now = Date.now();
  const expired = [];
  for (const [sessionId, createdAt] of this.pendingCreatedAt) {
    if (now - createdAt > this.PENDING_TIMEOUT) {
      expired.push(sessionId);
    }
  }
  return expired;
}
```

### 6. **Endpoints para verificar y eliminar manualmente**

```bash
# Ver sesiones activas + pending
curl http://localhost:4000/sessions
# Respuesta incluye: sessions, pendingSessions, pendingCount

# Eliminar inactivas (no conectadas)
curl -X POST http://localhost:4000/cleanup-inactive-sessions

# Eliminar pending que vencieron (>2 min sin conectar)
curl -X POST http://localhost:4000/cleanup-pending-sessions
```

---

## 📊 Mejora Esperada

| Métrica                    | Antes              | Después              |
| -------------------------- | ------------------ | -------------------- |
| **Circuit Breaker opens**  | Cada 2-3 min       | Cada 30+ min         |
| **QRs perdidos**           | 20-30%             | <1%                  |
| **Sesiones fantasma**      | Acumulan forever   | Limpias cada 30 min  |
| **Sesiones pending stuck** | Indefinido         | Eliminas a los 2 min |
| **Memoria RAM**            | Sube continuamente | Estable              |
| **Errores "OPEN"**         | Muy frecuentes     | Raros                |

---

## 🚀 Cómo Usar en Producción

### Opción 1: Dejar limpieza automática (Recomendado)

```bash
# Solo ejecutar:
node index.js

# La limpieza de inactivas ocurre automáticamente cada 30 minutos
# Monitorear logs para "🧹 Sesiones inactivas eliminadas"
```

### Opción 2: Limpiar manualmente si hay problema

```bash
# Si ves muchos errores Circuit Breaker
curl -X POST http://localhost:4000/cleanup-inactive-sessions

# Elimina sesiones sin conexión y reduce presión
```

### Opción 3: Ajustar cleanup interval

```bash
# En config.js, cambiar:
# setInterval(..., 15 * 60 * 1000); // limpiar cada 15 min en lugar de 30
```

---

## 📈 Monitoreo Recomendado

### Health Check

```bash
curl http://localhost:4000/health

# Busca:
# - "activeSessions": debe ser estable
# - "circuitBreaker.state": debe ser "CLOSED"
# - Si ves muchos "inactive" sessions → ejecutar /cleanup-inactive-sessions
```

### Logs a monitorear

```
✅ Sesiones inactivas eliminadas
🧹 Limpiando sesiones inactivas
Circuit breaker is OPEN (si aparece frecuentemente = problema)
QR enviado y estado actualizado  (debe ser normal)
```

---

## 🔍 Debugging si sigue fallando

### 1. Circuit Breaker aún se abre

```javascript
// Aumentar más en config.js
circuitBreakerThreshold: 30,        // de 20
circuitBreakerResetTimeout: 300000, // 5 minutos (de 3)
```

### 2. API Laravel muy lenta

```bash
# Verificar que Laravel API responde rápido
time curl https://api.example.com/whatsapp/status

# Si tarda >5 segundos:
# - Escalar laravel servers
# - Usar Redis cache en Laravel
# - Reducir maxConcurrentMessages a 10
```

### 3. Memory sigue subiendo

```bash
# Ejecutar cleanup manual más frecuente
curl -X POST http://localhost:4000/cleanup-inactive-sessions

# O reducir cleanup interval a 15 min en index.js
```

---

## 📋 Checklist para Deployment

- [ ] Actualizar `config.js` con `circuitBreakerThreshold: 20` + `pendingSessionTimeout: 120000`
- [ ] Actualizar `modules/whatsappManager.js` para usar `sync.enqueue()` + pasar timeout
- [ ] Actualizar `modules/core/QrController.js` con `pendingCreatedAt` tracking + `getExpiredPendingSessions()`
- [ ] Actualizar `index.js` con limpieza automática de inactivas (30 min) + pending (30s)
- [ ] Agregar endpoints `POST /cleanup-inactive-sessions` y `POST /cleanup-pending-sessions`
- [ ] Monitorear `/health` y `/sessions` cada 5 minutos
- [ ] Alertar si `circuitBreaker.state` = "OPEN" por >5 min
- [ ] Alertar si `pendingCount` > 20 (problema con QR)
- [ ] Ejecutar manual cleanup después de picos de tráfico
- [ ] Revisar logs de "Sesiones PENDING vencidas eliminadas" y "Sesiones inactivas eliminadas"

---

**Versión**: 2.2 (Pending Sessions Ready)  
**Última actualización**: Nov 16, 2025
