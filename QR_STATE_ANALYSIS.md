# 🔍 Análisis Detallado: Problema de Estados QR

## El Problema

**Síntoma Reportado**:

```
"QR se genera pero no transiciona a estado 'active'
Permanece en 'pending' y Baileys intenta reconectar"
```

**Log Observado**:

```
🔄 Reintentando conexión
```

---

## 🎯 Causa Raíz Probable

### Escenario 1: Race Condition en Transición de Estado

```
Timeline:
┌─────────────────────────────────────────────────┐
│ Usuario abre sesión                             │
└─────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────┐
│ QRManager genera QR                             │
│ POST /qr y POST /whatsapp/status → "pending"    │
└─────────────────────────────────────────────────┘
                    ↓
        ┌───────────────────┐
        │ Esperar conexión  │
        │ (30-60 segundos)  │
        └───────────────────┘
                    ↓
        ┌───────────────────────────────────────┐
        │ Usuario escanea QR en teléfono         │
        │ Baileys emite: connection='open'       │
        └───────────────────────────────────────┘
                    ↓
    ┌───────────────────────────────────┐
    │ connectionManager.handleSessionOpen() llamado
    │ POST /whatsapp/status → "active"  │
    └───────────────────────────────────┘
                    ↓
           ✅ CORRECTO: estado = "active"
```

### Escenario 2: Reconexión Múltiple (MÁS PROBABLE)

```
Timeline:
┌──────────────────────────────────────────┐
│ Conexión abierta                         │
│ POST /whatsapp/status → "active"  ✅     │
└──────────────────────────────────────────┘
            ↓
    (Algunos segundos después)
            ↓
┌──────────────────────────────────────────┐
│ Baileys pierde conexión (red inestable)  │
│ Emite: connection='close'                │
└──────────────────────────────────────────┘
            ↓
    connectionManager.handleSessionClose()
            ↓
    ┌──────────────────────────┐
    │ ¿loggedOut? NO           │
    │ isSessionActive? SÍ      │
    │ → Reintentar conexión    │
    └──────────────────────────┘
            ↓
    sessionManager.startSession() llamado nuevamente
            ↓
    ⚠️ PROBLEMA: ¿QR se regenera?
    ¿POST /qr nuevamente?
    ¿Estado vuelve a "pending"?
```

---

## 🔬 Puntos de Investigación

### ❓ Pregunta 1: ¿handleSessionOpen() Se Llama Múltiples Veces?

**Ubicación**: `modules/whatsapp/connectionManager.js`

```javascript
async handleSessionOpen(sessionId, sessionManager) {
  this.logger.info("✅ Sesión abierta (connection='open')", { sessionId });

  // ⚠️ QUESTION: ¿Se llama este múltiples veces?

  await this.postLaravel("/whatsapp/status", {
    session_id: sessionId,
    estado_qr: "active",
  });
}
```

**Investigación**:

- Agregar contador: `this.openedCount[sessionId]++`
- Loguear cada vez que se llama
- Ver si se ejecuta 1 vez o múltiples veces

**Esperado**: 1 vez por sesión (cuando se conecta exitosamente)

---

### ❓ Pregunta 2: ¿Hay Conflicto Entre QRManager y ConnectionManager?

**Escenario Problemático**:

```
TIEMPO   QRManager                    ConnectionManager
────────────────────────────────────────────────────────
T0       generateQR()
T1       POST /qr
T2       POST /status → "pending"
T3       [Esperando escaneo]
T4                                    connection='open'
T5                                    POST /status → "active"
T6       ⚠️ handleQrCode() llamado?    ← Todavía recibe eventos de QR?
T7       Si regenera QR...
T8       POST /status → "pending" ❌   Sobrescribe el "active"!
```

**Verificación en Code**:

```javascript
// En qrManager.js → handleQrCode()
async handleQrCode(qr, sessionId, connectionStatus) {
  if (!qr || connectionStatus === "open") return;  // ← Debería ignorar QR cuando open

  // ...

  // ⚠️ PREGUNTA: ¿qué pasa si connectionStatus != "open"?
  // ¿Se regenera el QR cuando se reconecta?
}
```

---

### ❓ Pregunta 3: ¿Laravel Actualiza Correctamente el Estado?

**Ubicación**: En tu API Laravel `/whatsapp/status`

**Puntos a Verificar**:

```php
// Laravel Controller
public function updateStatus(Request $request) {
    $session = WhatsappAccount::find($request->session_id);

    // ⚠️ VERIFICAR:
    // 1. ¿Se actualiza estado_qr correctamente?
    $session->estado_qr = $request->estado_qr;  // ← Persiste?
    $session->save();

    // 2. ¿Se usa SoftDelete? (podría ocultar registros)
    // 3. ¿Hay listeners que actualizan otros campos?
}

// Consulta de estado
public function getStatus($sessionId) {
    $session = WhatsappAccount::find($sessionId);
    return response()->json(['estado_qr' => $session->estado_qr]);
}
```

---

## 💡 Soluciones Propuestas

### Solución 1: Idempotencia en handleSessionOpen()

```javascript
// MEJORADO: Cambiar estado solo si está en "pending"
async handleSessionOpen(sessionId, sessionManager) {
  this.logger.info("✅ Sesión abierta", { sessionId });

  try {
    // Obtener estado actual
    const currentStatus = await sessionManager.getSessionStatus(sessionId);

    this.logger.info("📊 Estado actual en Laravel", {
      sessionId,
      currentStatus,
    });

    // Solo cambiar si está en "pending"
    if (currentStatus === "pending") {
      await this.postLaravel("/whatsapp/status", {
        session_id: sessionId,
        estado_qr: "active",
      });

      this.logger.info("✅ Estado cambiado: pending → active", { sessionId });
    } else {
      this.logger.warn("⚠️ Estado no es pending, ignorando", {
        sessionId,
        currentStatus,
      });
    }
  } catch (err) {
    this.logger.error("❌ Error en handleSessionOpen", err, { sessionId });
  }
}
```

**Ventaja**: Evita sobrescrituras de estado si se llama múltiples veces.

---

### Solución 2: Deshabilitar Regeneración de QR en Reconexión

```javascript
// En connectionManager.js → handleSessionClose()
async handleSessionClose(sessionId, userId, lastDisconnect, sessionManager) {
  const statusCode = lastDisconnect?.error?.output?.statusCode;
  const loggedOut = statusCode === DisconnectReason.loggedOut;

  if (!loggedOut) {
    // Reconexión automática
    const active = await sessionManager.isSessionActiveInLaravel(sessionId);

    if (active) {
      // ⚠️ MEJORA: No llamar startSession nuevamente
      // (que regeneraría el QR)
      // En su lugar, simplemente reconectar sin nuevo QR

      this.logger.info("🔄 Reintentando conexión sin nuevo QR", { sessionId });

      // Pasar eventManager para reutilizar socket anterior
      await sessionManager.reconnectSession(sessionId);
    }
  }
}
```

**Ventaja**: Reutiliza QR existente en lugar de generar uno nuevo.

---

### Solución 3: Agregar Bloqueo de Transiciones Inválidas

```javascript
// En sessionManager.js
class SessionManager {
  constructor(...) {
    this.stateTransitions = new Map(); // { sessionId: timestamp }
  }

  /**
   * Evita cambios de estado muy frecuentes
   */
  async updateStateWithThrottle(sessionId, newState) {
    const lastChange = this.stateTransitions.get(sessionId) || 0;
    const now = Date.now();
    const timeSinceLastChange = now - lastChange;

    // Máximo 1 cambio de estado cada 2 segundos
    if (timeSinceLastChange < 2000) {
      this.logger.warn("⏱️ Throttle de estado activo", {
        sessionId,
        newState,
        waitMs: 2000 - timeSinceLastChange,
      });
      return;
    }

    await this.postLaravel("/whatsapp/status", {
      session_id: sessionId,
      estado_qr: newState,
    });

    this.stateTransitions.set(sessionId, now);
  }
}
```

**Ventaja**: Evita race conditions por cambios de estado muy rápidos.

---

## 🧪 Test de Diagnóstico

Crea este script para investigar:

```javascript
// test-qr-state-flow.js
const axios = require("axios");

const LARAVEL_API = "http://localhost:8000/api";
const sessionId = "test-session-12345";

async function logStatus(label) {
  try {
    const { data } = await axios.get(
      `${LARAVEL_API}/whatsapp/status/${sessionId}`
    );
    console.log(`[${label}] Estado actual: ${data.estado_qr}`);
    return data.estado_qr;
  } catch (err) {
    console.error(`[${label}] Error: ${err.message}`);
  }
}

async function updateStatus(newState) {
  try {
    await axios.post(`${LARAVEL_API}/whatsapp/status`, {
      session_id: sessionId,
      estado_qr: newState,
    });
    console.log(`   Actualizado a: ${newState}`);
  } catch (err) {
    console.error(`   Error: ${err.message}`);
  }
}

async function test() {
  console.log("🧪 Test de Flujo de Estados QR\n");

  await logStatus("INICIO");

  console.log("\n1️⃣ Simular generación de QR");
  await updateStatus("pending");
  await logStatus("DESPUÉS DE GENERAR QR");

  console.log("\n2️⃣ Simular escaneo (3 segundos después)");
  await new Promise((r) => setTimeout(r, 3000));

  console.log("\n3️⃣ Simular conexión exitosa");
  await updateStatus("active");
  await logStatus("DESPUÉS DE CONEXIÓN");

  console.log("\n4️⃣ Simular reconexión (llamar handle nuevamente)");
  await updateStatus("active");
  await logStatus("DESPUÉS DE RECONEXIÓN");

  console.log("\n✅ Test completado");
}

test().catch(console.error);
```

**Cómo usar**:

```bash
node test-qr-state-flow.js
```

---

## 📋 Checklist de Debugging

- [ ] Agregar logging detallado en `handleSessionOpen()`
- [ ] Contar cuántas veces se llama `handleSessionOpen()` por sesión
- [ ] Verificar si `getSessionStatus()` retorna el estado correcto
- [ ] Revisar si `handleQrCode()` se ejecuta después de conexión abierta
- [ ] Verificar que Laravel persiste el estado correctamente
- [ ] Ejecutar `test-qr-state-flow.js` para diagnosticar
- [ ] Implementar idempotencia en `handleSessionOpen()`
- [ ] Agregar throttle de cambios de estado
- [ ] Validar que no hay cambios de estado simultáneos

---

## 🎯 Resumen

**Problema**: QR no transiciona de "pending" a "active"

**Causas Probables**:

1. `handleSessionOpen()` se llama múltiples veces
2. `handleQrCode()` regenera QR en reconexión
3. Estados se sobrescriben por race condition
4. Laravel no persiste estado correctamente

**Soluciones**:

1. ✅ Hacer `handleSessionOpen()` idempotente
2. ✅ Evitar regeneración de QR en reconexión
3. ✅ Agregar throttle de cambios de estado
4. ✅ Loguear cada cambio de estado

**Próximo Paso**: Ejecutar el test de diagnóstico y revisar logs.
