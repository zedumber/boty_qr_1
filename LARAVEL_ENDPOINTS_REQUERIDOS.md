# 📋 ENDPOINTS REQUERIDOS EN LARAVEL

Tu aplicación Node ahora envía datos en **BATCH**, por lo que necesitas crear 2 nuevos endpoints en Laravel.

## 🚀 Endpoint 1: Recibir Batch de QR Codes

### Ruta (Laravel):

```php
Route::post('/api/qr/batch', [YourController::class, 'storeQrBatch']);
```

### Método del Controller:

```php
<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Models\WhatsappAccount; // O el modelo que uses

class QrController extends Controller
{
    /**
     * Recibe múltiples QR codes en un batch
     *
     * Body JSON:
     * {
     *   "qrs": [
     *     {"session_id": "abc123", "qr": "data:image/png;base64,..."},
     *     {"session_id": "def456", "qr": "data:image/png;base64,..."}
     *   ]
     * }
     */
    public function storeQrBatch(Request $request)
    {
        try {
            $validated = $request->validate([
                'qrs' => 'required|array|min:1',
                'qrs.*.session_id' => 'required|string|uuid',
                'qrs.*.qr' => 'required|string',
            ]);

            $qrs = $validated['qrs'];
            $updated = 0;
            $failed = 0;

            foreach ($qrs as $qrData) {
                try {
                    $account = WhatsappAccount::where(
                        'session_id',
                        $qrData['session_id']
                    )->first();

                    if (!$account) {
                        $failed++;
                        continue;
                    }

                    // Guardar QR
                    $account->update([
                        'qr_code' => $qrData['qr'],
                        'qr_generated_at' => now(),
                    ]);

                    // Notificar al usuario (WebSocket, Pusher, etc.)
                    // event(new QrGenerated($account));

                    $updated++;
                } catch (\Exception $e) {
                    \Log::error('Error guardando QR', [
                        'session_id' => $qrData['session_id'],
                        'error' => $e->getMessage(),
                    ]);
                    $failed++;
                }
            }

            return response()->json([
                'success' => true,
                'message' => "Procesados $updated QR codes",
                'updated' => $updated,
                'failed' => $failed,
            ]);

        } catch (\Exception $e) {
            \Log::error('Error en batch QR', ['error' => $e->getMessage()]);

            return response()->json([
                'success' => false,
                'error' => $e->getMessage(),
            ], 422);
        }
    }
}
```

---

## 🚀 Endpoint 2: Recibir Batch de Status Updates

### Ruta (Laravel):

```php
Route::post('/api/whatsapp/status/batch', [WhatsappController::class, 'updateStatusBatch']);
```

### Método del Controller:

```php
<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Models\WhatsappAccount;

class WhatsappController extends Controller
{
    /**
     * Actualiza estado de múltiples sesiones en batch
     *
     * Body JSON:
     * {
     *   "statuses": [
     *     {"session_id": "abc123", "estado_qr": "active"},
     *     {"session_id": "def456", "estado_qr": "pending"},
     *     {"session_id": "ghi789", "estado_qr": "inactive"}
     *   ]
     * }
     *
     * Estados permitidos:
     * - "pending": Esperando escaneo del QR
     * - "active": Usuario conectado
     * - "connecting": Reintentando conexión
     * - "inactive": Sin conexión o desconectado
     */
    public function updateStatusBatch(Request $request)
    {
        try {
            $validated = $request->validate([
                'statuses' => 'required|array|min:1',
                'statuses.*.session_id' => 'required|string|uuid',
                'statuses.*.estado_qr' => 'required|in:pending,active,connecting,inactive',
            ]);

            $statuses = $validated['statuses'];
            $updated = 0;
            $failed = 0;

            // Procesar todos en una transacción
            \DB::beginTransaction();

            try {
                foreach ($statuses as $statusData) {
                    try {
                        $account = WhatsappAccount::where(
                            'session_id',
                            $statusData['session_id']
                        )->first();

                        if (!$account) {
                            $failed++;
                            continue;
                        }

                        $oldStatus = $account->estado_qr;
                        $newStatus = $statusData['estado_qr'];

                        // Actualizar estado
                        $account->update([
                            'estado_qr' => $newStatus,
                            'last_status_update' => now(),
                        ]);

                        // Registrar cambio importante
                        if ($newStatus === 'active' && $oldStatus !== 'active') {
                            $account->update(['connected_at' => now()]);
                            // Notificar que se conectó
                            // event(new WhatsappConnected($account));
                        } else if ($newStatus === 'inactive' && $oldStatus === 'active') {
                            // Notificar que se desconectó
                            // event(new WhatsappDisconnected($account));
                        }

                        $updated++;
                    } catch (\Exception $e) {
                        \Log::error('Error actualizando status', [
                            'session_id' => $statusData['session_id'],
                            'error' => $e->getMessage(),
                        ]);
                        $failed++;
                    }
                }

                \DB::commit();

            } catch (\Exception $e) {
                \DB::rollBack();
                throw $e;
            }

            return response()->json([
                'success' => true,
                'message' => "Actualizados $updated estados",
                'updated' => $updated,
                'failed' => $failed,
            ]);

        } catch (\Exception $e) {
            \Log::error('Error en batch status', ['error' => $e->getMessage()]);

            return response()->json([
                'success' => false,
                'error' => $e->getMessage(),
            ], 422);
        }
    }
}
```

---

## 📊 Schema de BD necesario

Asegúrate de tener estas columnas en tu tabla `whatsapp_accounts`:

```sql
CREATE TABLE whatsapp_accounts (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    session_id CHAR(36) UNIQUE NOT NULL,

    -- QR
    qr_code LONGTEXT NULL, -- Almacenar imagen base64
    qr_generated_at TIMESTAMP NULL,

    -- Estado
    estado_qr ENUM('pending', 'active', 'connecting', 'inactive') DEFAULT 'pending',
    last_status_update TIMESTAMP NULL,
    connected_at TIMESTAMP NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_session_id (session_id),
    INDEX idx_estado_qr (estado_qr),
    INDEX idx_user_id (user_id)
);
```

---

## 🔄 Compatibilidad hacia atrás

Los **viejos endpoints siguen funcionando**, así que no breaks en tu aplicación:

- ✅ `POST /api/qr` - Sigue funcionando (single QR)
- ✅ `POST /api/whatsapp/status` - Sigue funcionando (single status)

El Node ahora usa los endpoints batch, pero podrías mantener ambos para compatibilidad.

---

## 📈 Ventajas de esta arquitectura

| Aspecto               | Antes             | Después              |
| --------------------- | ----------------- | -------------------- |
| Peticiones por QR     | 1 petición/QR     | 50 QR/1 petición     |
| Peticiones por status | 1 petición/status | 50 status/1 petición |
| Latencia DB           | 50 queries        | 1 query              |
| Carga en Laravel      | ⚠️ Alta           | ✅ Mínima            |
| Escalabilidad         | 100 usuarios      | 1000+ usuarios       |

---

## 🚀 Migración desde Antigua Arquitectura

Si ya tienes los endpoints antiguos, puedes:

**Opción 1: Mantener ambos**

- Node usa endpoints batch
- Otros servicios pueden usar endpoints single
- Cero conflictos

**Opción 2: Reemplazar completamente**

- Eliminar endpoints antiguos
- Usar solo batch
- Más limpio

Te recomiendo **Opción 1** para transición segura.

---

## ✅ Testear endpoints

```bash
# Test batch QR
curl -X POST http://localhost:8000/api/qr/batch \
  -H "Content-Type: application/json" \
  -d '{
    "qrs": [
      {
        "session_id": "abc-123",
        "qr": "data:image/png;base64,iVBORw0KGgo..."
      }
    ]
  }'

# Test batch status
curl -X POST http://localhost:8000/api/whatsapp/status/batch \
  -H "Content-Type: application/json" \
  -d '{
    "statuses": [
      {"session_id": "abc-123", "estado_qr": "active"},
      {"session_id": "def-456", "estado_qr": "pending"}
    ]
  }'
```

---

**¡Listo! Tu arquitectura ahora es 10x más escalable! 🚀**
