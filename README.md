# 🚀 WhatsApp Server - Versión Modular

Servidor Node.js para gestionar sesiones de WhatsApp usando Baileys, integrado con Laravel.

## 📁 Estructura del Proyecto

```
prue/
├── index_new.js              # Servidor principal (NUEVA VERSIÓN MODULAR)
├── index.js                  # Servidor antiguo (mantener como backup)
├── config/
│   ├── config.js            # ⚙️ Configuración centralizada
│   └── index.js             # Configuración legacy
├── modules/
│   ├── messageReceiver.js   # 📥 Recepción y procesamiento de mensajes
│   ├── messageSender.js     # 📤 Envío de mensajes con reintentos
│   ├── queueManager.js      # 📊 Gestión de colas Bull/Redis
│   └── whatsappManager.js   # 📱 Gestión de sesiones WhatsApp
├── utils/
│   ├── lidResolver.js       # 🔍 Resolución de LIDs (Local Identifiers)
│   └── logger.js            # 📝 Sistema de logging estructurado
├── services/                # Archivos legacy
│   ├── messageHandler.js
│   ├── messageSender.js
│   └── whatsapp.js
├── auth/                    # 🔐 Credenciales de sesiones WhatsApp
│   └── [session-id]/        # Carpeta por sesión
│       ├── creds.json
│       ├── lid-mapping-*_reverse.json
│       └── ...
├── audios/                  # 🔊 Archivos de audio temporales
├── package.json
└── README.md
```

## 🎯 Mejoras Implementadas

### 1. **Modularización Completa**

- Código separado por responsabilidad
- Fácil mantenimiento y testing
- Reutilización de componentes

### 2. **Resolución de LIDs Mejorada** ✨

Los LIDs (Local Identifiers) como `123456@lid` son identificadores temporales de WhatsApp Business. Ahora se resuelven con múltiples estrategias:

- **Estrategia 1**: `jidNormalizedUser()` con `remoteJidAlt` (preferido)
- **Estrategia 2**: Extracción directa si es `@s.whatsapp.net`
- **Estrategia 3**: Lectura de archivos `lid-mapping-*_reverse.json`
- **Estrategia 4**: Fallback seguro

Ver: `utils/lidResolver.js`

### 3. **Sistema de Colas Robusto**

- Circuit Breaker para protección de servicios
- Métricas de rendimiento en tiempo real
- Procesamiento concurrente configurable
- Reintentos automáticos con backoff exponencial

### 4. **Gestión de Sesiones**

- Throttling y deduplicación de QR codes
- Reconexión automática inteligente
- Restauración de sesiones al reiniciar
- Limpieza automática de recursos

### 5. **Logging Estructurado**

- JSON logs para fácil parsing
- Niveles: INFO, WARN, ERROR, DEBUG
- Metadatos contextuales en cada log

## 🚀 Uso

### Iniciar Servidor (Nueva Versión)

```bash
node index_new.js
```

### Iniciar Servidor (Versión Antigua - Backup)

```bash
node index.js
```

## 📡 API Endpoints

### 1. Crear Sesión

```http
POST /start
Content-Type: application/json

{
  "user_id": "123"
}

Response:
{
  "success": true,
  "session_id": "uuid-v4"
}
```

### 2. Enviar Mensaje

```http
POST /send-message
Content-Type: application/json

{
  "session_id": "uuid",
  "wa_id": "573001234567",
  "type": "text|image|audio|video|document",
  "body": "Texto del mensaje",
  "mediaUrl": "https://...",
  "caption": "Caption opcional",
  "filename": "documento.pdf"
}
```

### 3. Health Check

```http
GET /health

Response:
{
  "status": "OK",
  "timestamp": "2025-10-05T...",
  "uptime": 3600,
  "activeSessions": 5,
  "queues": {
    "messageQueue": { ... },
    "metrics": { ... }
  }
}
```

### 4. Listar Sesiones

```http
GET /sessions

Response:
{
  "success": true,
  "count": 5,
  "sessions": [...]
}
```

### 5. Información de Sesión

```http
GET /session/:sessionId
```

### 6. Eliminar Sesión

```http
DELETE /session/:sessionId
```

## ⚙️ Configuración

Editar `config/config.js`:

```javascript
module.exports = {
  // Laravel API
  laravelApi: "http://localhost:8000/api",

  // Puerto del servidor
  port: 4000,

  // Redis
  redisHost: "localhost",
  redisPort: 6379,

  // Colas
  maxConcurrentMessages: 5,
  messageProcessingTimeout: 30000,

  // QR Codes
  qrThrottleMs: 30000,
  qrExpiresMs: 60000,

  // ...más configuraciones
};
```

## 🔍 Resolución de LIDs - Explicación Detallada

### ¿Qué son los LIDs?

Los LIDs son identificadores locales temporales que WhatsApp Business API usa cuando no puede obtener el número de teléfono real inmediatamente. Se ven así:

```
155147774775462@lid
```

### ¿Por qué son un problema?

Laravel/tu backend necesita el número real (ej: `573001234567`) para:

- Guardar en base de datos
- Asociar con contactos
- Enviar respuestas

### ¿Cómo los resolvemos?

#### 1. **jidNormalizedUser con remoteJidAlt**

Baileys proporciona `remoteJidAlt` que puede contener el número real:

```javascript
const candidateJid = msg.key.remoteJidAlt || fromRaw;
const normalized = jidNormalizedUser(candidateJid);
// → "573001234567@s.whatsapp.net"
```

#### 2. **Archivos de mapeo reverse**

Baileys guarda archivos como `lid-mapping-155147774775462_reverse.json`:

```json
"573001234567"
```

Leemos estos archivos para resolver el LID:

```javascript
const reverseMapPath = `lid-mapping-${lid}_reverse.json`;
const phone = JSON.parse(fs.readFileSync(reverseMapPath));
```

#### 3. **Fallback seguro**

Si todo falla, extraemos lo que podamos y loggeamos para debugging:

```javascript
fromClean = fromRaw.replace(/(@s\.whatsapp\.net|@lid)$/i, "");
logger.warn("Usando remitente sin resolver", { fromRaw, fromClean });
```

### Archivo: `utils/lidResolver.js`

```javascript
const { resolveLid } = require("./utils/lidResolver");

// Uso:
const phoneNumber = resolveLid(
  msg.key.remoteJid, // "155147774775462@lid"
  sessionId, // "uuid-session"
  msg, // objeto mensaje completo
  logger // logger instance
);
// → "573001234567"
```

## 🔧 Debugging

### Ver LIDs disponibles para una sesión

```javascript
const { listLidMappings } = require("./utils/lidResolver");

const mappings = listLidMappings(sessionId, logger);
console.log(mappings);
// [
//   { lid: '155147774775462', phone: '573001234567', filePath: '...' },
//   { lid: '185302220058669', phone: '573109876543', filePath: '...' }
// ]
```

### Ver logs estructurados

Los logs en formato JSON facilitan el debugging:

```json
{
  "timestamp": "2025-10-05T10:30:00.123Z",
  "level": "INFO",
  "service": "whatsapp-service",
  "message": "Remitente resuelto vía jidNormalizedUser",
  "candidateJid": "155147774775462@lid",
  "normalized": "573001234567@s.whatsapp.net",
  "fromClean": "573001234567",
  "sessionId": "uuid-..."
}
```

## 🐳 Docker

Si usas Docker, ajusta en `config/config.js`:

```javascript
// En Docker Compose
laravelApi: "http://boty_qr_back:8030/api",
redisHost: "redis_saas",
```

## 📊 Métricas y Monitoreo

El sistema incluye métricas automáticas:

```javascript
{
  "messagesProcessed": 1500,
  "messagesFailed": 23,
  "avgProcessingTime": 245,  // ms
  "successRate": "98.5%",
  "queueCounts": {
    "waiting": 12,
    "active": 5,
    "completed": 1500,
    "failed": 23
  }
}
```

## 🧹 Limpieza Automática

- **Audios**: Limpiados cada 15 minutos (más de 1 hora de antigüedad)
- **Jobs de cola**: Completados > 24h son eliminados automáticamente

## 🛡️ Circuit Breaker

Protege la API de Laravel de sobrecarga:

- **Threshold**: 5 fallos consecutivos
- **Timeout**: 60 segundos antes de reintentar
- **Estados**: CLOSED → OPEN → HALF_OPEN → CLOSED

## 📝 Notas Importantes

1. **Migración**: `index.js` original se mantiene como backup
2. **Producción**: Usar `index_new.js` que es la versión modular
3. **Testing**: Probar primero en desarrollo antes de producción
4. **LIDs**: Siempre verificar los logs para asegurar resolución correcta

## 🤝 Integración con Laravel

### Rutas esperadas en Laravel (ver `rotas_laravel.php`):

- `POST /api/qr` - Recibir QR code
- `POST /api/whatsapp/status` - Actualizar estado de sesión
- `GET /api/whatsapp/account/{sessionId}` - Obtener cuenta
- `POST /api/whatsapp-webhook/{token}` - Recibir mensajes
- `GET /api/whatsapp/accounts/active` - Listar cuentas activas

### Ejemplo de webhook Laravel (`laravel_ejemplo.php`):

```php
// WhatsappAccountController.php
public function getAccountBySession($sessionId) {
    $account = WhatsappAccount::where('session_id', $sessionId)->first();
    return response()->json([
        "id" => $account->id,
        "webhook_token" => $account->webhook_token,
        "status" => $account->estado_qr
    ]);
}
```

## 🚦 Estado del Proyecto

✅ **Completado**:

- Modularización completa
- Resolución de LIDs mejorada
- Sistema de colas robusto
- Logging estructurado
- API RESTful completa

⏳ **Próximos pasos sugeridos**:

- Tests unitarios para cada módulo
- Documentación de API con Swagger
- Dashboard de monitoreo
- Websockets para notificaciones en tiempo real

## 📞 Soporte

Para problemas o preguntas, revisar los logs estructurados que incluyen toda la información de contexto necesaria para debugging.

---

**Versión**: 2.0.0 (Modular)  
**Fecha**: Octubre 2025  
**Autor**: Sistema de WhatsApp con Baileys
