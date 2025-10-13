
Route::post('/qr', [WhatsappAccountController::class, 'saveQr']);
Route::post('/whatsapp/status', [WhatsappAccountController::class, 'updateStatus']);
Route::get('/whatsapp/account/{sessionId}', [WhatsappAccountController::class, 'getAccountBySession']);
Route::post('/whatsapp-webhook/{token}', [MessageController::class, 'reciveMessage']);
Route::get('/accounts/{sessionId}', [WhatsappAccountController::class, 'show']);
Route::post('/whatsapp/regenerate-qr', [WhatsappAccountController::class, 'regenerateQr']);
// Route::get('/whatsapp/status/{sessionId}', [WhatsappAccountController::class, 'checkStatus']);
Route::get('/whatsapp/status/{sessionId}', [WhatsappAccountController::class, 'checkStatus']);

Route::get('/whatsapp/accounts/active', [WhatsappAccountController::class, 'active']);
// routes/api.php
Route::get('/whatsapp/find-webhook/{sessionId}', [WhatsappAccountController::class, 'findWebhook']);

Route::post('/v1/account/registration', [AccountController::class, 'register']);// registrar cuenta


Route::get('/cotizaciones/{slug}', [CotizacionController::class, 'show']);
Route::put('/cotizaciones/{slug}', [CotizacionController::class, 'update']);

Route::get('/pro/{account_id}', [FileController::class, 'index'])->name('productos.index');//listar productos


