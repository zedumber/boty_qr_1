# 🏗️ Diagrama de Arquitectura - WhatsApp Manager Modular

## 1. Flujo de Inicialización

```
┌─────────────────────────────────────────────────────────────────┐
│                       index.js (Main)                           │
│                   initializeModules()                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │ QueueManager    │
                    │ (Redis)         │
                    └────────┬────────┘
                             │
                    ┌────────▼──────────────────────┐
                    │ WhatsAppManager (Fachada)    │
                    │ Constructor                  │
                    └────────┬──────────────────────┘
                             │
        ┌────────────────────┼────────────────────┬──────────────┐
        │                    │                    │              │
   ┌────▼─────┐      ┌──────▼─────┐      ┌──────▼─────┐  ┌────▼──────┐
   │ Session  │      │     QR     │      │Connection │  │   Event    │
   │ Manager  │      │   Manager  │      │ Manager   │  │  Manager   │
   │          │      │            │      │           │  │            │
   │ Manages: │      │ Manages:   │      │ Manages:  │  │ Manages:   │
   │ • Sesión │      │ • Throttle │      │ • Open    │  │ • Listener │
   │ • Auth   │      │ • Dedup    │      │ • Close   │  │ • Coord.   │
   │ • Meta   │      │ • Expire   │      │ • Retry   │  │ • Clean    │
   └──────────┘      └────────────┘      └───────────┘  └────────────┘
```

---

## 2. Flujo: POST /start (Crear Sesión)

```
Client Request
    │
    ├─ POST /start { user_id: 123 }
    │
    ▼
index.js:/start endpoint
    │
    ├─ Generar sessionId (UUID)
    ├─ Validar user_id
    │
    ▼
whatsappManager.startSession(sessionId, userId)
    │
    ├─ Delegar a → SessionManager.startSession()
    │
    ▼
SessionManager.startSession()
    │
    ├─ Crear directorio: ./auth/sessionId/
    ├─ Cargar credenciales: useMultiFileAuthState()
    ├─ Obtener versión: fetchLatestBaileysVersion()
    ├─ Crear socket: makeWASocket()
    │
    ├─ Registrar listeners:
    │  └─ eventManager.registerSessionEvents()
    │
    ├─ Guardar en memoria: sessions[sessionId] = socket
    ├─ Guardar metadata: sessionMetadata[sessionId] = { userId, createdAt, lastActivity }
    │
    ▼
✅ Response: { success: true, session_id: "uuid-123" }
    │
    Client recibe QR code (próximo flujo)
```

---

## 3. Flujo: Baileys Event - QR Code

```
Baileys Library
    │
    ├─ Genera: qr = "00000000-0000-0000..."
    ├─ Evento: socket.ev.on('connection.update', update)
    │  update = { qr, connection, lastDisconnect }
    │
    ▼
EventManager._handleConnectionUpdate()
    │
    ├─ Delegación a:
    │  ├─ connectionManager.handleConnectionUpdate()
    │  └─ qrManager.handleQrCode()
    │
    ▼
QRManager.handleQrCode(qr, sessionId, 'disconnected')
    │
    ├─ Verificar: ¿Sesión activa en Laravel?
    │  └─ GET /whatsapp/status/{sessionId} ← Laravel API
    │
    ├─ Check 1: ¿QR nuevo?
    │  └─ if (qr === lastQrSent[sessionId]) return SKIP
    │
    ├─ Check 2: ¿Throttle activo?
    │  └─ if (now - lastQrAt[sessionId] < 30000) return SKIP
    │
    ├─ Check 3: ¿Envío en curso?
    │  └─ if (inflightQr[sessionId]) return SKIP
    │
    ├─ ENVIAR QR:
    │  ├─ POST /qr { session_id, qr } → Laravel
    │  ├─ POST /whatsapp/status { session_id, estado_qr: 'pending' } → Laravel
    │  ├─ Actualizar: lastQrSent[sessionId] = qr
    │  ├─ Actualizar: lastQrAt[sessionId] = now
    │
    ├─ Configurar expiración:
    │  └─ setTimeout(() => { mark as 'inactive' }, 60000)
    │
    ▼
✅ QR enviado a Laravel, usuario escanea con teléfono
```

---

## 4. Flujo: Baileys Event - Connection Update

```
Baileys Library
    │
    ├─ connection.update event
    │  ├─ update = { connection: 'open' | 'close' }
    │
    ▼
EventManager._handleConnectionUpdate()
    │
    ├─ connectionManager.handleConnectionUpdate()
    │
    ├─ if (connection === 'open')
    │  │
    │  ├─ Limpiar estado QR
    │  ├─ POST /whatsapp/status { estado_qr: 'active' } → Laravel
    │  ├─ Ejecutar: onSessionOpen callback (si existe)
    │
    └─ if (connection === 'close')
       │
       ├─ Obtener: DisconnectReason (loggedOut?)
       │
       ├─ if (loggedOut === true)
       │  │
       │  ├─ POST /whatsapp/status { estado_qr: 'inactive' } → Laravel
       │  ├─ Limpiar: sessions[sessionId] = null
       │
       └─ if (loggedOut === false)
          │
          ├─ Verificar en Laravel: ¿Sesión activa?
          │
          ├─ if (activa)
          │  └─ Reconectar: startSession(sessionId, userId)
          │
          └─ if (no activa)
             └─ Log: "SessionId inactivo, sin reconexión"
```

---

## 5. Flujo: Mensaje Entrante (messages.upsert)

```
Baileys Library / WhatsApp Server
    │
    ├─ Nuevo mensaje recibido
    ├─ Evento: socket.ev.on('messages.upsert', msgUpdate)
    │  msgUpdate = {
    │    messages: [{
    │      key: { id, remoteJid, fromMe },
    │      message: { conversation: "texto", ... },
    │      timestamp
    │    }],
    │    type: 'notify'
    │  }
    │
    ▼
EventManager._handleMessagesUpsert(msgUpdate, sessionId)
    │
    ├─ sessionManager.updateLastActivity(sessionId)
    │
    ├─ queueManager.addMessageToQueue(msgUpdate, sessionId)
    │  │
    │  ├─ Crear job en Bull queue
    │  ├─ { msgUpdate, sessionId }
    │  │
    │  ▼
    │  QueueManager.processMessages() [async]
    │  │
    │  ├─ messageReceiver.processMessage()
    │  │  │
    │  │  ├─ Validar mensaje
    │  │  ├─ Extraer información (from, type, body)
    │  │  ├─ Enviar a Laravel API
    │  │  ├─ Guardar audio si es necesario
    │  │  ├─ Marcar como leído (si aplica)
    │  │  │
    │  │  ▼
    │  │  POST /messages → Laravel
    │  │
    │  ▼
    │  ✅ Mensaje procesado y guardado
    │
    ▼
✅ Mensaje registrado en BD Laravel
```

---

## 6. Flujo: Enviar Mensaje (messageSender)

```
Laravel API
    │
    ├─ POST /send-message
    │  {
    │    session_id: "uuid-123",
    │    wa_id: "1234567890",
    │    type: "text" | "audio" | "image",
    │    body: "Hola",
    │    mediaUrl: "https://...",
    │    caption: "..."
    │  }
    │
    ▼
index.js:/send-message endpoint
    │
    ├─ Validar: ¿Sesión existe?
    │  └─ if (!whatsappManager.sessions[session_id])
    │     return 404
    │
    ├─ messageSender.sendMessage({...})
    │  │
    │  ├─ Obtener socket: sock = sessions[session_id]
    │  │
    │  ├─ if (type === 'text')
    │  │  └─ sock.sendMessage(wa_id@s.whatsapp.net, { text: body })
    │  │
    │  ├─ if (type === 'audio')
    │  │  ├─ Descargar: mediaUrl
    │  │  └─ sock.sendMessage(wa_id@s.whatsapp.net, { audio, mimetype })
    │  │
    │  ├─ if (type === 'image')
    │  │  ├─ Descargar: mediaUrl
    │  │  └─ sock.sendMessage(wa_id@s.whatsapp.net, { image, caption })
    │  │
    │  ▼
    │  ✅ Mensaje enviado a WhatsApp
    │
    ▼
✅ Response: { success: true, message_id: "..." }
```

---

## 7. Flujo: Limpieza de Sesión Inactiva

```
monitor.cleanupInactiveSessions()
    │
    ├─ Obtener lista: whatsappManager.listActiveSessions()
    │
    ├─ Por cada sesión:
    │  │
    │  ├─ Calcular: inactiveTime = now - session.lastActivity
    │  │
    │  ├─ if (inactiveTime > 30 min)
    │  │  │
    │  │  ├─ whatsappManager.deleteSession(sessionId)
    │  │  │  │
    │  │  │  ├─ sessionManager.deleteSession()
    │  │  │  │  │
    │  │  │  │  ├─ Cerrar socket: socket.end()
    │  │  │  │  ├─ Limpiar: sessions[sessionId] = null
    │  │  │  │  ├─ Limpiar: sessionMetadata[sessionId] = null
    │  │  │  │  ├─ qrManager.clearQrState(sessionId)
    │  │  │  │  │  ├─ Cancelar: qrTimeouts[sessionId]
    │  │  │  │  │  ├─ Limpiar: lastQrSent.delete()
    │  │  │  │  │  ├─ Limpiar: lastQrAt.delete()
    │  │  │  │  │  └─ Limpiar: inflightQr.delete()
    │  │  │  │  │
    │  │  │  │  ├─ Eliminar archivos: ./auth/sessionId/
    │  │  │  │  │
    │  │  │  │  ▼
    │  │  │  │  ✅ Sesión eliminada completamente
    │  │  │  │
    │  │  │  └─ Actualizar BD: UPDATE sessions SET status='inactive'
    │  │  │
    │  │  └─ Log: "Sesión inactiva eliminada"
    │  │
    │  └─ else → continuar
    │
    ▼
✅ Limpieza completada
```

---

## 8. Flujo: Shutdown Graceful

```
SIGTERM / SIGINT signal
    │
    ▼
gracefulShutdown(whatsappManager, queueManager)
    │
    ├─ app.disable('requests')
    │  └─ No aceptar nuevas peticiones
    │
    ├─ whatsappManager.closeAllSessions()
    │  │
    │  ├─ Por cada sessionId:
    │  │  │
    │  │  ├─ socket.end()
    │  │  ├─ sessionManager.deleteSession(sessionId)
    │  │  ├─ qrManager.clearQrState(sessionId)
    │  │  └─ Eliminar archivos auth
    │  │
    │  ▼
    │  ✅ Todas las sesiones cerradas
    │
    ├─ queueManager.shutdown()
    │  │
    │  ├─ Procesar jobs pendientes
    │  ├─ Cerrar conexión Redis
    │  │
    │  ▼
    │  ✅ Cola finalizada
    │
    ▼
✅ Shutdown completado, process.exit(0)
```

---

## 9. Estadísticas en Tiempo Real

```
whatsappManager.getStats()
    │
    ├─ sessionManager.getSessionStats()
    │  ├─ totalSessions: Object.keys(sessionMetadata).length
    │  ├─ activeSessions: socket.user count
    │  ├─ inactiveSessions: lastActivity > 5 min
    │  └─ oldestSession: min(now - createdAt)
    │
    ├─ qrManager.getQRStats()
    │  ├─ pendingQR: Array(inflightQr).filter(v => v).length
    │  └─ trackedSessions: lastQrSent.size
    │
    ▼
Response:
{
  sessions: {
    totalSessions: 150,
    activeSessions: 148,
    inactiveSessions: 2,
    oldestSession: 3600000
  },
  qr: {
    pendingQR: 5,
    trackedSessions: 42
  },
  timestamp: "2025-11-16T..."
}
```

---

## 10. Matriz de Responsabilidades

```
┌──────────────────────┬──────────┬──────────┬──────────┬──────────┐
│ Responsabilidad      │ Session  │   QR     │ Connect  │  Event   │
├──────────────────────┼──────────┼──────────┼──────────┼──────────┤
│ Crear sesión         │    ✓     │          │          │          │
│ Eliminar sesión      │    ✓     │    ✓     │          │          │
│ Cargar credenciales  │    ✓     │          │          │          │
│ Generar QR           │          │    ✓     │          │          │
│ Throttle QR          │          │    ✓     │          │          │
│ Expirar QR           │          │    ✓     │          │          │
│ Reconexión           │          │          │    ✓     │          │
│ Callbacks            │          │          │    ✓     │          │
│ Listeners Baileys    │          │          │          │    ✓     │
│ Coordinación         │          │          │          │    ✓     │
│ Metadata sesión      │    ✓     │          │          │          │
└──────────────────────┴──────────┴──────────┴──────────┴──────────┘
```

---

## 11. Dependencias Entre Componentes

```
                        ┌─────────────────┐
                        │  index.js       │
                        │  (Main Entry)   │
                        └────────┬────────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
                ▼                ▼                ▼
        ┌───────────────┐  ┌──────────┐  ┌──────────────┐
        │ WhatsApp      │  │Queue     │  │Message       │
        │Manager        │  │Manager   │  │Receiver/     │
        │(Fachada)      │  │(Redis)   │  │Sender        │
        └───────┬───────┘  └──────────┘  └──────────────┘
                │
    ┌───────────┼───────────┬──────────┐
    │           │           │          │
    ▼           ▼           ▼          ▼
┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐
│Session │ │  QR    │ │Connection│ │  Event   │
│Manager │ │Manager │ │Manager   │ │Manager   │
└────────┘ └────────┘ └──────────┘ └──────────┘
    │           │           │          │
    └─────┬─────┘           └─────┬────┘
          │                       │
          └───────────┬───────────┘
                      │
              ┌───────▼──────┐
              │ Baileys      │
              │ (WhatsApp)   │
              └──────────────┘
```

---

## 12. Stack de Tecnología

```
┌─────────────────────────────────────────────────┐
│                   Node.js                        │
├─────────────────────────────────────────────────┤
│                 Express.js API                   │
├─────────────────────────────────────────────────┤
│             WhatsApp Manager (Modular)           │
│  ┌──────────┬──────────┬──────────┬──────────┐  │
│  │ Session  │   QR     │Connection│  Event   │  │
│  │ Manager  │ Manager  │ Manager  │ Manager  │  │
│  └──────────┴──────────┴──────────┴──────────┘  │
├─────────────────────────────────────────────────┤
│     ┌──────────────┐      ┌─────────────┐       │
│     │   Baileys    │      │ Bull Queue  │       │
│     │ (WhatsApp)   │      │  (Redis)    │       │
│     └──────────────┘      └─────────────┘       │
├─────────────────────────────────────────────────┤
│        Laravel API    │    Redis Server         │
│        (Backend)      │    (Message Queue)      │
└─────────────────────────────────────────────────┘
```

---

**Esta arquitectura modular escala de 100 a 1000+ usuarios sin problemas. 🚀**
