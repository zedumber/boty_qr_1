# 💡 Ejemplos Prácticos de Uso

## 🚀 Iniciar el Servidor

```bash
# Desarrollo
node index_new.js

# Producción con PM2
pm2 start index_new.js --name whatsapp-server
pm2 save
pm2 startup
```

---

## 📱 Crear una Nueva Sesión de WhatsApp

### Desde Laravel (PHP)

```php
// WhatsappAccountController.php
public function startSession(Request $request)
{
    $userId = auth()->id();

    // Crear registro en BD
    $account = WhatsappAccount::create([
        'user_id' => $userId,
        'webhook_token' => Str::uuid(),
        'estado_qr' => 'pending'
    ]);

    // Llamar a Node.js
    $response = Http::post("http://localhost:4000/start", [
        'user_id' => $userId
    ]);

    if ($response->successful()) {
        $data = $response->json();

        // Actualizar session_id
        $account->update([
            'session_id' => $data['session_id']
        ]);

        return response()->json([
            'success' => true,
            'session_id' => $data['session_id']
        ]);
    }
}
```

### Desde Postman

```http
POST http://localhost:4000/start
Content-Type: application/json

{
  "user_id": "123"
}

Response:
{
  "success": true,
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

## 📤 Enviar Mensaje de Texto

### Desde Laravel (PHP)

```php
// MessageController.php
public function sendMessage(Request $request)
{
    $account = WhatsappAccount::where('user_id', auth()->id())->first();

    $response = Http::post("http://localhost:4000/send-message", [
        'session_id' => $account->session_id,
        'wa_id' => '573001234567',
        'type' => 'text',
        'body' => '¡Hola! Este es un mensaje de prueba'
    ]);

    return $response->json();
}
```

### Desde Postman

```http
POST http://localhost:4000/send-message
Content-Type: application/json

{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "wa_id": "573001234567",
  "type": "text",
  "body": "¡Hola! Este es un mensaje de prueba"
}

Response:
{
  "success": true,
  "response": {
    "key": {
      "remoteJid": "573001234567@s.whatsapp.net",
      "fromMe": true,
      "id": "3EB0XXXX"
    },
    "status": 1
  }
}
```

---

## 🖼️ Enviar Imagen con Caption

### Desde Laravel (PHP)

```php
Http::post("http://localhost:4000/send-message", [
    'session_id' => $account->session_id,
    'wa_id' => '573001234567',
    'type' => 'image',
    'mediaUrl' => 'https://ejemplo.com/imagen.jpg',
    'caption' => 'Mira esta imagen'
]);
```

### Desde Postman

```http
POST http://localhost:4000/send-message
Content-Type: application/json

{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "wa_id": "573001234567",
  "type": "image",
  "mediaUrl": "https://ejemplo.com/imagen.jpg",
  "caption": "Mira esta imagen"
}
```

---

## 🔊 Enviar Audio

```http
POST http://localhost:4000/send-message
Content-Type: application/json

{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "wa_id": "573001234567",
  "type": "audio",
  "mediaUrl": "https://ejemplo.com/audio.mp3"
}
```

---

## 🎥 Enviar Video

```http
POST http://localhost:4000/send-message
Content-Type: application/json

{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "wa_id": "573001234567",
  "type": "video",
  "mediaUrl": "https://ejemplo.com/video.mp4",
  "caption": "Video tutorial"
}
```

---

## 📄 Enviar Documento

```http
POST http://localhost:4000/send-message
Content-Type: application/json

{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "wa_id": "573001234567",
  "type": "document",
  "mediaUrl": "https://ejemplo.com/documento.pdf",
  "filename": "factura_001.pdf",
  "caption": "Adjunto tu factura"
}
```

---

## 📊 Monitorear el Sistema

### Health Check

```bash
curl http://localhost:4000/health | jq .
```

```json
{
  "status": "OK",
  "timestamp": "2025-10-05T10:30:00.123Z",
  "uptime": 3600,
  "activeSessions": 5,
  "sessions": [
    {
      "exists": true,
      "connected": true,
      "user": {
        "id": "573001234567:42@s.whatsapp.net",
        "name": "Usuario"
      },
      "sessionId": "550e8400..."
    }
  ],
  "queues": {
    "messageQueue": {
      "waiting": 3,
      "active": 2,
      "completed": 1523,
      "failed": 12
    },
    "metrics": {
      "messagesProcessed": 1523,
      "messagesFailed": 12,
      "avgProcessingTime": 245,
      "successRate": "99.2%"
    }
  }
}
```

### Listar Sesiones Activas

```bash
curl http://localhost:4000/sessions | jq .
```

```json
{
  "success": true,
  "count": 3,
  "sessions": [
    {
      "exists": true,
      "connected": true,
      "user": { "id": "573001234567:42@s.whatsapp.net" },
      "sessionId": "550e8400..."
    }
  ]
}
```

### Ver Información de una Sesión Específica

```bash
curl http://localhost:4000/session/550e8400-e29b-41d4-a716-446655440000 | jq .
```

---

## 📥 Recibir Mensajes (Webhook de Laravel)

Cuando un mensaje entra a WhatsApp, Node.js lo procesa y lo envía a Laravel:

### Laravel debe tener esta ruta:

```php
// routes/api.php
Route::post('/whatsapp-webhook/{token}', [MessageController::class, 'reciveMessage']);
```

### Controlador en Laravel:

```php
// MessageController.php
public function reciveMessage(Request $request, $token)
{
    // Buscar cuenta por webhook_token
    $account = WhatsappAccount::where('webhook_token', $token)->first();

    if (!$account) {
        return response()->json(['error' => 'Token inválido'], 404);
    }

    // Datos recibidos desde Node.js
    $from = $request->input('from');           // "573001234567" (número resuelto)
    $text = $request->input('text');           // "Hola, necesito ayuda"
    $type = $request->input('type');           // "text", "audio", "image", etc.
    $wamId = $request->input('wamId');         // ID del mensaje
    $timestamp = $request->input('timestamp'); // Timestamp
    $pushName = $request->input('pushName');   // Nombre del contacto

    // Si es audio, viene el archivo
    if ($type === 'audio' && $request->hasFile('audio')) {
        $audioFile = $request->file('audio');
        $audioPath = $audioFile->store('audios', 'public');
    }

    // Guardar mensaje en BD
    $message = Message::create([
        'whatsapp_account_id' => $account->id,
        'from' => $from,
        'text' => $text,
        'type' => $type,
        'wam_id' => $wamId,
        'timestamp' => $timestamp,
        'push_name' => $pushName,
        'audio_path' => $audioPath ?? null
    ]);

    // Aquí puedes implementar tu lógica de respuesta automática
    // Por ejemplo, conectar con un chatbot, IA, etc.

    return response()->json(['success' => true]);
}
```

---

## 🔍 Debugging de LIDs

### Ver Archivos de Mapeo Disponibles

```javascript
// Desde Node.js o script de debug
const { listLidMappings } = require("./utils/lidResolver");
const logger = require("./utils/logger");

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const mappings = listLidMappings(sessionId, logger);

console.log("Archivos de mapeo encontrados:");
mappings.forEach((m) => {
  console.log(`LID: ${m.lid} → Phone: ${m.phone}`);
  console.log(`File: ${m.filePath}`);
});
```

### Output:

```
Archivos de mapeo encontrados:
LID: 155147774775462 → Phone: 573001234567
File: auth/550e8400.../lid-mapping-155147774775462_reverse.json

LID: 185302220058669 → Phone: 573109876543
File: auth/550e8400.../lid-mapping-185302220058669_reverse.json
```

---

## 🧹 Mantenimiento

### Limpiar Archivos de Audio Antiguos Manualmente

```javascript
// En messageReceiver
const MessageReceiver = require("./modules/messageReceiver");
const logger = require("./utils/logger");

const receiver = new MessageReceiver(axios, config.laravelApi, logger);

// Limpiar audios más viejos de 1 hora
receiver.cleanOldAudios(3600 * 1000);
```

### Limpiar Jobs Antiguos de la Cola

```bash
# Usando Redis CLI
redis-cli

# Ver todas las colas
KEYS bull:*

# Limpiar una cola específica
DEL bull:whatsapp-messages:completed
```

---

## 🔄 Reconexión Automática

El sistema reconecta automáticamente si se pierde la conexión:

```javascript
// whatsappManager.js ya maneja esto
// Cuando connection === "close" y NO es loggedOut:
if (!loggedOut && isSessionActive) {
  // Reintenta automáticamente
  await startSession(sessionId, userId);
}
```

---

## 🛑 Eliminar una Sesión

### Desde API

```bash
curl -X DELETE http://localhost:4000/session/550e8400-e29b-41d4-a716-446655440000
```

```json
{
  "success": true,
  "message": "Sesión eliminada correctamente"
}
```

### Desde Laravel

```php
public function deleteSession($sessionId)
{
    $response = Http::delete("http://localhost:4000/session/{$sessionId}");

    if ($response->successful()) {
        // También eliminar de BD
        WhatsappAccount::where('session_id', $sessionId)->delete();
    }
}
```

---

## 📊 Métricas en Tiempo Real

### Con Logs JSON

```bash
# Ver todos los logs
node index_new.js

# Filtrar solo errores
node index_new.js 2>&1 | jq 'select(.level == "ERROR")'

# Ver métricas de rendimiento
node index_new.js 2>&1 | jq 'select(.message == "Métricas de rendimiento")'
```

### Output de Métricas:

```json
{
  "timestamp": "2025-10-05T10:35:00.456Z",
  "level": "INFO",
  "service": "whatsapp-service",
  "message": "Métricas de rendimiento",
  "messagesProcessed": 1600,
  "messagesFailed": 15,
  "avgProcessingTime": 238,
  "successRate": "99.1%",
  "queueCounts": {
    "waiting": 5,
    "active": 3,
    "completed": 1600,
    "failed": 15
  }
}
```

---

## 🐳 Uso con Docker

### docker-compose.yml

```yaml
version: "3.8"

services:
  whatsapp-server:
    build: .
    ports:
      - "4000:4000"
    environment:
      - LARAVEL_API=http://laravel-backend:8000/api
      - REDIS_HOST=redis
      - REDIS_PORT=6379
    volumes:
      - ./auth:/app/auth
      - ./audios:/app/audios
    depends_on:
      - redis
    command: node index_new.js

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

### Dockerfile

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 4000

CMD ["node", "index_new.js"]
```

---

## 🔐 Seguridad

### Proteger Endpoints con Token

```javascript
// En index_new.js
const API_TOKEN = process.env.API_TOKEN || "tu-token-secreto";

function authenticateToken(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];

  if (token !== API_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }

  next();
}

// Aplicar a rutas sensibles
app.post("/start", authenticateToken, async (req, res) => {
  // ...
});
```

---

## 📝 Testing

### Test Básico con cURL

```bash
# 1. Health check
curl http://localhost:4000/health

# 2. Crear sesión
SESSION=$(curl -s -X POST http://localhost:4000/start \
  -H "Content-Type: application/json" \
  -d '{"user_id":"test"}' | jq -r '.session_id')

echo "Session ID: $SESSION"

# 3. Esperar QR y conectar...

# 4. Enviar mensaje de prueba
curl -X POST http://localhost:4000/send-message \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION\",
    \"wa_id\": \"573001234567\",
    \"type\": \"text\",
    \"body\": \"Test desde cURL\"
  }"
```

---

Estos ejemplos cubren los casos de uso más comunes. ¡Adapta según tus necesidades! 🚀
