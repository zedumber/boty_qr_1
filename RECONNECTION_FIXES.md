# 🔄 Correcciones de Reconexión - WhatsApp Service

## 🔴 Problemas Identificados

### 1. **Race Condition en Validación de Estado**

```javascript
// ANTES: Solo "active" era válido
const isActive = redisStatus === "active";

// PROBLEMA: Durante reconexión, estado es "connecting"
// → isSessionActive() retorna false
// → Reconexión se cancela prematuramente
```

### 2. **Timeout Fijo sin Backoff**

```javascript
// ANTES: Siempre 2.5 segundos
setTimeout(() => {
  reconnect();
}, 2500);

// PROBLEMA:
// - Conexión inestable → reintenta cada 2.5s infinitamente
// - Puede saturar el servidor
// - No hay límite de reintentos
```

### 3. **Cache Stale Durante Reconexión**

```javascript
// ANTES: Cache se limpiaba solo en logout
this.sessionActiveCache.delete(sessionId); // Solo en logout

// PROBLEMA:
// - Durante reconexión normal, cache tiene datos viejos
// - isSessionActive() usa cache stale
// - Validaciones incorrectas
```

### 4. **No Validaba Estado Antes de Reconectar**

```javascript
// ANTES: Reconectaba sin validar
await this.startSession(sessionId, userId, token);

// PROBLEMA:
// - Si Laravel marcó sesión como inactive, igual reconecta
// - Desperdicia recursos en sesiones inválidas
```

### 5. **Error 401 No Se Manejaba**

```javascript
// ANTES: Solo manejaba logout (428) y 405
if (loggedOut) { ... }
if (statusCode === 405) { ... }

// FALTABA: 401 (unauthorized)
```

---

## ✅ Soluciones Implementadas

### 1. **isSessionActive() con Soporte para Reconexión**

```javascript
async isSessionActive(sessionId, options = {}) {
  // Nueva opción: forReconnect
  const isActive = options.forReconnect
    ? (redisStatus === "active" || redisStatus === "connecting")
    : redisStatus === "active";

  // Durante reconexión, "connecting" también es válido
}
```

**Beneficios**:

- ✅ Diferencia entre validación normal y reconexión
- ✅ "connecting" es válido durante reconexión
- ✅ No cancela reconexiones legítimas

---

### 2. **Backoff Exponencial con Límite de Reintentos**

```javascript
// NUEVO: Contador de reintentos
this.sessions[sessionId].reconnectAttempts = (attempts || 0) + 1;
const attempt = this.sessions[sessionId].reconnectAttempts;
const maxAttempts = 5;

// NUEVO: Backoff exponencial
const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 32000);

// Tiempos: 2s, 4s, 8s, 16s, 32s (máximo)
```

**Progresión de Reintentos**:

```
Intento 1: 2 segundos   (2^0 * 2000 = 2000ms)
Intento 2: 4 segundos   (2^1 * 2000 = 4000ms)
Intento 3: 8 segundos   (2^2 * 2000 = 8000ms)
Intento 4: 16 segundos  (2^3 * 2000 = 16000ms)
Intento 5: 32 segundos  (2^4 * 2000 = 32000ms)
```

**Límite**: Después de 5 intentos → marca como "inactive"

---

### 3. **Limpieza de Cache en Todas las Desconexiones**

```javascript
async handleSessionClose(sessionId, userId, lastDisconnect) {
  // NUEVO: Siempre limpiar cache
  this.clearQrState(sessionId);
  this.sessionActiveCache.delete(sessionId); // ← Movido al inicio

  // Luego evaluar si reconectar o no
}
```

**Beneficios**:

- ✅ Cache siempre fresco
- ✅ No hay validaciones con datos stale
- ✅ isSessionActive() consulta fuentes actualizadas

---

### 4. **Validación Antes de Reconectar**

```javascript
setTimeout(async () => {
  // NUEVO: Validar que sesión sigue siendo válida
  const isValid = await this.isSessionActive(sessionId, { forReconnect: true });

  if (!isValid) {
    this.logger.warn("⚠️ Sesión ya no es válida para reconectar");
    delete this.sessions[sessionId];
    return; // ← Cancela reconexión
  }

  // Proceder con reconexión
  await this.startSession(...);
}, backoffMs);
```

**Beneficios**:

- ✅ No reconecta sesiones inactivas en Laravel
- ✅ Ahorra recursos del servidor
- ✅ Evita reconexiones innecesarias

---

### 5. **Manejo de Error 401 (Unauthorized)**

```javascript
// NUEVO: Manejo de 401
if (statusCode === 401) {
  this.logger.warn("⛔ Sesión cerrada con 401, marcando INACTIVE");
  await this.cacheManager.setStatus(sessionId, "inactive");
  this.batchQueueManager.addStatus(sessionId, "inactive", "high");
  delete this.sessions[sessionId];
  return; // ← No reconectar
}
```

**Códigos No Reconectables**:

- ❌ `428` (loggedOut) - Usuario cerró sesión manualmente
- ❌ `405` (credenciales corruptas) - Auth inválida
- ❌ `401` (unauthorized) - No autorizado

---

### 6. **Reset de Contador en Reconexión Exitosa**

```javascript
// En startSession: Reset counter
this.sessions[sessionId] = {
  sock,
  state,
  saveCreds,
  userId,
  webhookToken,
  reconnectAttempts: 0, // ← Reset en éxito
  reconnecting: false,
};
```

**Beneficios**:

- ✅ Si reconecta con éxito, contador vuelve a 0
- ✅ Permite manejar desconexiones futuras
- ✅ No penaliza por desconexiones antiguas

---

### 7. **Cierre de Socket Anterior Antes de Reconectar**

```javascript
setTimeout(async () => {
  // NUEVO: Cerrar socket anterior si existe
  if (this.sessions[sessionId]?.sock) {
    try {
      this.sessions[sessionId].sock.end();
    } catch (_) {
      // Ignorar errores
    }
  }

  // Crear nuevo socket
  await this.startSession(...);
}, backoffMs);
```

**Beneficios**:

- ✅ Evita múltiples sockets abiertos simultáneamente
- ✅ Libera recursos antes de reconectar
- ✅ Previene memory leaks

---

## 📊 Flujo de Reconexión Mejorado

### Escenario 1: Reconexión Exitosa

```
1. connection='close' (statusCode != 401/405/428)
   ↓
2. Limpiar cache y estado QR
   ↓
3. Marcar estado "connecting" en Redis/Laravel
   ↓
4. Incrementar reconnectAttempts (intento 1)
   ↓
5. Calcular backoff: 2s
   ↓
6. setTimeout(2000ms)
   ↓
7. Validar isSessionActive({ forReconnect: true })
   ↓ (válido)
8. Cerrar socket anterior
   ↓
9. startSession()
   ↓
10. connection='open' → estado "active"
    ↓
11. Reset reconnectAttempts = 0 ✅
```

---

### Escenario 2: Reconexión con Reintentos

```
1. connection='close' → Intento 1 (backoff: 2s)
   ↓ (falla)
2. connection='close' → Intento 2 (backoff: 4s)
   ↓ (falla)
3. connection='close' → Intento 3 (backoff: 8s)
   ↓ (falla)
4. connection='close' → Intento 4 (backoff: 16s)
   ↓ (falla)
5. connection='close' → Intento 5 (backoff: 32s)
   ↓ (falla)
6. Máximo alcanzado → estado "inactive" ❌
```

---

### Escenario 3: Sesión Invalidada Durante Reconexión

```
1. connection='close'
   ↓
2. Marcar "connecting"
   ↓
3. setTimeout(2000ms)
   ↓
4. [Usuario elimina cuenta en Laravel]
   ↓
5. isSessionActive({ forReconnect: true })
   ↓ (retorna false)
6. Cancelar reconexión
   ↓
7. delete sessions[sessionId] ✅
```

---

## 🎯 Comparación Antes/Después

| Aspecto                        | Antes       | Después               |
| ------------------------------ | ----------- | --------------------- |
| **Backoff**                    | Fijo 2.5s   | Exponencial 2s-32s    |
| **Límite de reintentos**       | ❌ Infinito | ✅ Máximo 5           |
| **Validación pre-reconexión**  | ❌ No       | ✅ Sí                 |
| **Cache durante reconexión**   | ⚠️ Stale    | ✅ Limpio             |
| **Estado "connecting" válido** | ❌ No       | ✅ Sí (en reconexión) |
| **Manejo de 401**              | ❌ No       | ✅ Sí                 |
| **Cierre de socket anterior**  | ❌ No       | ✅ Sí                 |
| **Reset de contador**          | ❌ No       | ✅ En éxito           |

---

## 🧪 Testing de Reconexión

### Caso 1: Desconexión Temporal (Red Inestable)

```bash
# Simular: Desconectar WiFi 5 segundos

Esperado:
1. connection='close'
2. Estado → "connecting"
3. Espera 2s (backoff intento 1)
4. Intenta reconectar
5. [Reconectar WiFi]
6. connection='open'
7. Estado → "active" ✅
```

### Caso 2: Desconexión Prolongada

```bash
# Simular: Desconectar WiFi 2 minutos

Esperado:
1-5. Intentos con backoff: 2s, 4s, 8s, 16s, 32s
6. Máximo alcanzado
7. Estado → "inactive" ❌
```

### Caso 3: Usuario Elimina Cuenta Durante Reconexión

```bash
# Simular:
1. Desconectar sesión
2. Mientras reconecta, eliminar cuenta en Laravel

Esperado:
1. connection='close'
2. setTimeout(2s)
3. isSessionActive() → false (cuenta eliminada)
4. Cancelar reconexión ✅
```

---

## 📝 Logs de Reconexión

### Reconexión Exitosa

```
📡 Actualización de conexión { connection: 'close', sessionId: 'abc123' }
🔌 Sesión cerrada { sessionId: 'abc123', statusCode: undefined, loggedOut: false }
🔄 Programando reconexión { sessionId: 'abc123', attempt: 1, maxAttempts: 5, backoffMs: 2000 }
[... 2 segundos ...]
🔄 Ejecutando reconexión { sessionId: 'abc123', attempt: 1 }
🚀 Iniciando sesión { sessionId: 'abc123', userId: '456' }
📡 Actualización de conexión { connection: 'open', sessionId: 'abc123' }
✅ Sesión abierta { sessionId: 'abc123' }
✅ Sesión iniciada correctamente { sessionId: 'abc123' }
```

### Máximo de Reintentos Alcanzado

```
🔄 Programando reconexión { attempt: 1, backoffMs: 2000 }
❌ Error en reconexión { sessionId: 'abc123', attempt: 1 }
🔄 Programando reconexión { attempt: 2, backoffMs: 4000 }
❌ Error en reconexión { sessionId: 'abc123', attempt: 2 }
...
❌ Máximo de reintentos alcanzado { sessionId: 'abc123', attempt: 5 }
```

---

## ✅ Checklist de Validación

- [x] Backoff exponencial implementado
- [x] Límite de 5 reintentos
- [x] Validación antes de reconectar
- [x] Cache se limpia en todas las desconexiones
- [x] "connecting" es válido durante reconexión
- [x] Manejo de error 401 agregado
- [x] Socket anterior se cierra antes de reconectar
- [x] Contador se resetea en éxito

---

## 🚀 Próximos Pasos

1. **Testing**: Probar con red inestable
2. **Monitoreo**: Agregar métricas de reconexión
3. **Ajustes**: Calibrar backoff según necesidad
4. **Logs**: Validar que logs sean claros

---

**Estado**: ✅ RECONEXIÓN MEJORADA  
**Backoff**: 2s → 4s → 8s → 16s → 32s  
**Límite**: 5 intentos máximo  
**Validación**: Pre-reconexión implementada
