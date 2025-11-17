<?php

use App\Http\Controllers\MessageController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\WhatsAppBotController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\WhatsappAccountController;
use App\Http\Controllers\ContactController;
use App\Http\Controllers\BotSettingController;
use App\Http\Controllers\FileController;
use App\Http\Controllers\NegocioController;
use App\Http\Controllers\IntencionesController;
use App\Http\Controllers\BotDisabledUserController;
use App\Http\Controllers\AccountController;
use App\Http\Controllers\CitaController;
use App\Http\Controllers\ContactoResumenController;
use App\Http\Controllers\ContactoCampaniaHistorialController;
use App\Http\Controllers\EnviarCarritoController;
use Illuminate\Support\Facades\Broadcast;
use App\Http\Controllers\PlanController;    
use App\Http\Controllers\SubscriptionController;
use App\Http\Controllers\PaymentController;
use App\Http\Controllers\UpdateController;
use App\Http\Controllers\BoardController;
use App\Http\Controllers\ColumnController;
use App\Http\Controllers\CardController;
use App\Http\Controllers\MassMessageController;
use App\Http\Controllers\AppointmentController;
use App\Http\Controllers\MediaFileController;






/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
|
| Here is where you can register API routes for your application. These
| routes are loaded by the RouteServiceProvider within a group which
| is assigned the "api" middleware group. Enjoy building your API!
|
*/
Route::post('/login', [AuthController::class, 'login'])->name('login');

Route::group([
 
    'middleware' => 'auth:api',
    'prefix' => 'auth'
 
], function ($router) {

 

    Route::post('/logout', [AuthController::class, 'logout'])->name('logout');
    Route::post('/refresh', [AuthController::class, 'refresh'])->name('refresh');
    Route::post('/me', [AuthController::class, 'me'])->name('me');
    Route::put('/user', [AuthController::class, 'updateProfile']);





    
    Route::post('/broadcasting/auth', function (Request $request) {
        $user = auth('api')->user()->load('whatsappAccount');
    
        \Log::info('📥 Broadcast Auth Request', $request->all());
        \Log::info('✅ Usuario autenticado para Broadcast', ['id' => $user->id, 'account_id' => $user->account_id]);
    
        return Broadcast::auth($request);
    })->middleware('auth:api');
    
    

    // Route::apiResources(['whatsapp-accounts' => WhatsappAccountController::class,]);
    // Route::get('whatsapp-accounts/check', [WhatsappAccountController::class, 'check']);

    // Route::get('/updates', [UpdateController::class, 'index']);// Rutas para manejar las novedades
    Route::apiResource('updates', UpdateController::class);

    Route::get('/media', [MediaFileController::class, 'index']);
    Route::post('/media/upload', [MediaFileController::class, 'upload']);
    Route::delete('/media/{mediaFile}', [MediaFileController::class, 'destroy']);

// routes/api.php
Route::apiResource('plans', PlanController::class);// Rutas para manejar los planes
Route::apiResource('subscriptions', SubscriptionController::class);// Rutas para manejar las suscripciones
Route::apiResource('payments', PaymentController::class);// Rutas para manejar los pagos
//qr
Route::get('/whatsapp/qr/{session_id}', [WhatsappAccountController::class, 'getQr']); //yes
Route::post('/whatsapp/start', [WhatsappAccountController::class, 'startSession']);//yes
Route::apiResource('whatsapp-accounts', WhatsappAccountController::class);// Rutas para manejar los planes yes



Route::apiResources(['boards' => BoardController::class,]);
Route::apiResources(['columns' => ColumnController::class,]);
Route::apiResources(['cards' => CardController::class,]);
Route::get('/inbox', [CardController::class, 'inbox']);// ruta para inbox


Route::get('/cuentas', [WhatsappAccountController::class, 'cuentas']);//traer todas las cuentas de whatsapp


Route::apiResources(['messages' => MessageController::class,]);

Route::post('/send-message-templates', [MessageController::class, 'sendMessageTemplate']); // para mandar mjs masivos
Route::get('/message-templates', [MessageController::class, 'loadMessageTemplates']); // para cargar los templetes segun el usuario

Route::apiResources(['contacts' => ContactController::class,]);
Route::post('/contacts/import', [ContactController::class, 'import']);


  Route::get('/mass-messages', [MassMessageController::class, 'index']);

    // Crear mensaje masivo
    Route::post('/mass-messages', [MassMessageController::class, 'store']);

    // Mostrar mensaje específico
    Route::get('/mass-messages/{massMessage}', [MassMessageController::class, 'show']);

    // Actualizar mensaje (ej. cambiar estado)
    Route::put('/mass-messages/{massMessage}', [MassMessageController::class, 'update']);

    // Eliminar mensaje
    Route::delete('/mass-messages/{massMessage}', [MassMessageController::class, 'destroy']);

// Rutas para manejar las citas
    Route::get('/appointments', [AppointmentController::class, 'index']);
    Route::post('/appointments', [AppointmentController::class, 'store']);
    Route::put('/appointments/{id}', [AppointmentController::class, 'update_citas']);
    Route::delete('/appointments/{id}', [AppointmentController::class, 'destroy']);    

Route::apiResources(['bot-setting' => BotSettingController::class,]);
Route::post('/bot', [BotSettingController::class, 'toggle']);

Route::post('/upload-excel', [FileController::class, 'uploadExcel']);// subir archivo excel

Route::get('/productos/{account_id}', [FileController::class, 'index'])->name('productos.index');//listar productos
Route::put('/productos/{id}', [FileController::class, 'edit'])->name('productos.edit');//editar productos
Route::delete('/producto/{id}', [FileController::class, 'destroy']);
Route::delete('/delete-user-data', [FileController::class, 'destroyUserData']);
Route::post('/productos', [FileController::class, 'store']);

Route::apiResources(['intenciones' => IntencionesController::class,]);
Route::delete('/intenciones', [IntencionesController::class, 'eliminar']);

Route::apiResources(['/pedidos' => EnviarCarritoController::class,]); // listar pedidos
Route::put('pedidos/{id}/estado', [EnviarCarritoController::class, 'actualizarEstadoDespacho']);


Route::get('/intenciones_ver', [MessageController::class, 'index_inteciones']);//listar intenciones


Route::put('/actualizar-intencion/{wa_id}', [MessageController::class, 'actualizarIntencionADespachada']);


// Route::post('/negocios', [NegocioController::class, 'guardarNegocio']);// guardar negocio
Route::get('/negocios', [NegocioController::class, 'index']); // Ver negocio
// Route::put('/negocio/editar/{id}', [NegocioController::class, 'editarNegocio']); // Editar negocio
Route::apiResources(['negocios' => NegocioController::class,]);


Route::post('/conversation/delete', [MessageController::class, 'deleteConversation']);

Route::post('/bot/toggle-status', [BotDisabledUserController::class, 'toggleBotStatus'])->middleware('auth:api');
// Ruta para obtener el estado del bot para un usuario específico
// Route::get('/bot/status', [BotDisabledUserController::class, 'getBotStatus'])->middleware('auth:api');

// Route::get('/citasfast', [CitaController::class, 'obtenerCitas']);// listar citas
// Route::post('/citasfast', [CitaController::class, 'crearCita']);// crear cita
Route::apiResource('citas', CitaController::class);// Rutas para manejar las citas
Route::get('/contacto-resumen', [ContactoResumenController::class, 'index']); // listar resumen de contactos del usuario autenticado
Route::get('/contacto-campania-historial', [ContactoCampaniaHistorialController::class, 'index']); // listar historial de contactos del usuario autenticado

});

Route::post('/register', [AuthController::class, 'register'])->name('register');
  

Route::middleware('auth:sanctum')->get('/user', function (Request $request) {
    return $request->user();
});

Route::get('/send-message', [MessageController::class, 'sendMessages']);
// Route::get('/whatsapp-webhook/{token}', [MessageController::class, 'verifyWebhook']);
// Route::get('/whatsapp-webhook', [MessageController::class, 'verifyWebhook']);
// Route::post('/whatsapp-webhook', [MessageController::class, 'processWebhook']);

Route::post('/bot', [WhatsAppBotController::class, 'handleIncomingMessage']);// apipara bot 

// Route::post('/mensajes/respuesta', [MessageController::class, 'sendAutoMessage']);
Route::post('/mensajes/respuesta', [MessageController::class, 'sendAutoMessage'])->withoutMiddleware('auth:api');

// Ruta para enviar mensajes automáticos de carrito
Route::post('/enviar/carrito', [EnviarCarritoController::class, 'recivir_pedido'])->withoutMiddleware('auth:api');



Route::post('/v1/account/registration', [AccountController::class, 'register']);// registrar cuenta




Route::post('/qr', [WhatsappAccountController::class, 'saveQr']);
Route::post('/whatsapp/status', [WhatsappAccountController::class, 'updateStatus']);
Route::post('/whatsapp/status/batch', [WhatsappAccountController::class, 'batchStatus']);
Route::post('/qr/batch', [WhatsappAccountController::class, 'batchQr']);

Route::get('/whatsapp/account/{sessionId}', [WhatsappAccountController::class, 'getAccountBySession']);
Route::post('/whatsapp-webhook/{token}', [MessageController::class, 'reciveMessage']);
Route::get('/accounts/{sessionId}', [WhatsappAccountController::class, 'show']);
Route::post('/whatsapp/regenerate-qr', [WhatsappAccountController::class, 'regenerateQr']);
// Route::get('/whatsapp/status/{sessionId}', [WhatsappAccountController::class, 'checkStatus']);
Route::get('/whatsapp/status/{session_id}', [WhatsappAccountController::class, 'checkStatus']);
Route::get('/whatsapp/status/token/{token}', [WhatsappAccountController::class, 'checkStatusByToken']);


Route::get('/whatsapp/accounts/active', [WhatsappAccountController::class, 'active'])
    ->withoutMiddleware(['throttle:api']);
// routes/api.php
Route::get('/whatsapp/find-webhook/{sessionId}', [WhatsappAccountController::class, 'findWebhook']);


// Rutas para manejar las citas
Route::put('/appointments/{slug}', [AppointmentController::class, 'update']);
Route::get('/appointments/{slug}', [AppointmentController::class, 'showBySlug']);
Route::get('/appointments/public/{slug}', [AppointmentController::class, 'citasOcupadas']);


// routes/api.php
Route::post('/forgot-password', [AuthController::class, 'forgotPassword']);
Route::post('/reset-password', [AuthController::class, 'resetPassword']);
