<?php

namespace App\Http\Controllers;

use App\Models\WhatsappAccount;
use App\Models\WeaviateConfig;
use App\Models\BotSetting;
use App\Models\Plan;
use App\Models\Subscription;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Carbon\Carbon;

class WhatsappAccountController extends Controller
{
    /**
     * 🔐 Devuelve las cuentas WhatsApp del usuario autenticado
     */
    public function index()
    {
        $userId = Auth::id();

        $accounts = WhatsappAccount::select(
                'id',
                'name',
                'phone_number',
                'session_id',
                'status',
                'estado_qr',
                'created_at',
                'updated_at'
            )
            ->where('user_id', $userId)
            ->get();

        return response()->json([
            'success'  => true,
            'accounts' => $accounts,
        ]);
    }

    /**
     * 🔍 Obtener cuenta por session_id (usado por el microservicio)
     */
    public function getAccountBySession(string $sessionId)
    {
        $account = WhatsappAccount::where('session_id', $sessionId)->first();

        if (!$account) {
            return response()->json([
                'status' => 'inactive',
            ], 404);
        }

        return response()->json([
            'id'            => $account->id,
            'user_id'       => $account->user_id,
            'webhook_token' => $account->webhook_token,
            'status'        => $account->estado_qr ?? 'inactive',
        ]);
    }

    public function startSession(Request $request)
{
    $userId = Auth::id();

    if (!$userId) {
        return response()->json(['error' => 'Usuario no autenticado'], 401);
    }

    // Obtener o crear cuenta
    $account = WhatsappAccount::firstOrCreate(
        ['user_id' => $userId],
        [
            'name' => 'Cuenta WhatsApp',
            'webhook_token' => Str::uuid(),
            'status' => 'inactive',
            'estado_qr' => 'pending',
        ]
    );

    // Generar nuevo SESSION_ID
    $newSessionId = Str::uuid();
    $account->update([
        'session_id' => $newSessionId,
        'estado_qr' => 'pending',
    ]);

    // Llamar a Node con ambos valores
    try {
        $baileysUrl = rtrim(env('BAILEYS_URL', 'http://localhost:4000'), '/');

        $response = Http::timeout(5)->post("{$baileysUrl}/start", [
            'user_id'       => $userId,
            'session_id'    => $newSessionId,
            'webhook_token' => $account->webhook_token,
        ]);

    } catch (\Throwable $e) {
        return response()->json([
            'error' => 'Error conectando con Node',
            'details' => $e->getMessage()
        ], 500);
    }

    if ($response->failed()) {
        return response()->json(['error' => 'Node rechazó la sesión'], 500);
    }

    return response()->json([
        'session_id'     => $newSessionId,
        'webhook_token'  => $account->webhook_token,
        'account'        => $account,
    ]);
}

    /**
     * 👥 Listado de usuarios + info básica de cuenta WhatsApp
     */
    public function cuentas()
    {
        $usuarios = User::with('whatsappAccount')->get();

        $result = $usuarios->map(function ($user) {
            return [
                'id'    => $user->id,
                'name'  => $user->name,
                'email' => $user->email,
                'phone' => $user->phone,
                'whatsapp_account' => $user->whatsappAccount ? [
                    'id'                => $user->whatsappAccount->id,
                    'phone_number'      => $user->whatsappAccount->phone_number,
                    'phone_number_id'   => $user->whatsappAccount->phone_number_id,
                ] : null,
            ];
        });

        return response()->json([
            'success' => true,
            'data'    => $result,
        ]);
    }

    /**
     * 🔎 Estado de una cuenta según session_id (para frontend / debug)
     */
    public function checkStatus(string $session_id)
    {
        $account = WhatsappAccount::where('session_id', $session_id)->first();

        if (!$account) {
            return response()->json([
                'error' => 'Cuenta no encontrada',
            ], 404);
        }

        return response()->json([
            'estado_qr' => $account->estado_qr,
            'status'    => $account->status,
        ]);
    }

 public function checkStatusByToken(string $token)
{
    $account = WhatsappAccount::where('webhook_token', $token)->first();

    if (!$account) {
        return response()->json(['error' => 'no encontrado'], 404);
    }

    return response()->json([
        'estado_qr' => $account->estado_qr,
        'status' => $account->status,
    ]);
}



    /**
     * 📥 Guardar QR que envía Baileys (USADO POR NODE)
     *
     * ⚠ IMPORTANTE:
     *  - No debe lanzar 404 hacia Node (Circuit Breaker).
     *  - Si la cuenta no existe, respondemos 200 con "skipped".
     */
    public function saveQr(Request $request)
    {
        $validated = $request->validate([
            'session_id' => 'required|uuid',
            'qr'         => 'required|string',
        ]);

        try {
            $account = WhatsappAccount::where('session_id', $validated['session_id'])
                ->select('id', 'session_id', 'qr', 'estado_qr')
                ->first();

            if (!$account) {
                Log::warning('⚠️ saveQr: Cuenta no encontrada para session_id', [
                    'session_id' => $validated['session_id'],
                ]);

                // 200 para no disparar el Circuit Breaker
                return response()->json([
                    'success' => true,
                    'skipped' => true,
                    'reason'  => 'account_not_found',
                ]);
            }

            $account->qr        = $validated['qr'];
            $account->estado_qr = 'pending';
            $account->save(['timestamps' => false]);

            return response()->json([
                'success' => true,
                'message' => 'QR guardado correctamente',
            ]);
        } catch (\Throwable $e) {
            Log::error('❌ saveQr: Error interno', [
                'message'    => $e->getMessage(),
                'session_id' => $validated['session_id'],
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Error interno al guardar el QR',
            ], 500);
        }
    }

    public function batchQr(Request $request)
{
    $validated = $request->validate([
        'qrs' => 'required|array',
        'qrs.*.session_id' => 'required|uuid',
        'qrs.*.qr' => 'required|string',
    ]);

    $items = $validated['qrs'];

    foreach ($items as $item) {
        WhatsappAccount::where('session_id', $item['session_id'])
            ->update([
                'qr'        => $item['qr'],
                'estado_qr' => 'pending',
            ]);
    }

    return response()->json([
        'success' => true,
        'processed' => count($items),
    ]);
}


    /**
     * 📤 Obtener QR para el frontend
     */
    public function getQr(string $session_id)
    {
        $account = WhatsappAccount::where('session_id', $session_id)
            ->select('qr', 'estado_qr')
            ->first();

        if (!$account || !$account->qr) {
            return response()->json([
                'error' => 'QR no encontrado',
            ], 404);
        }

        return response()->json([
            'qr'        => $account->qr,
            'estado_qr' => $account->estado_qr,
        ]);
    }

    /**
     * 🔄 Regenerar QR (crea nueva sesión en Node y actualiza cuenta)
     */
    public function regenerateQr(Request $request)
    {
        $validated = $request->validate([
            'session_id' => 'required|uuid',
        ]);

        try {
            $baileysUrl = rtrim(env('BAILEYS_URL', 'http://localhost:4000'), '/');

            $response = Http::timeout(5)->post("{$baileysUrl}/start", [
                'user_id' => Auth::id(),
            ]);

            if ($response->failed()) {
                return response()->json([
                    'error' => 'No se pudo regenerar QR',
                ], 500);
            }

            $data      = $response->json();
            $newId     = $data['session_id'] ?? null;

            if (!$newId) {
                return response()->json([
                    'error' => 'No se recibió nuevo session_id desde Baileys',
                ], 500);
            }

            $account = WhatsappAccount::where('session_id', $validated['session_id'])->first();

            if (!$account) {
                return response()->json([
                    'error' => 'Cuenta no encontrada para regenerar QR',
                ], 404);
            }

            $account->update([
                'session_id' => $newId,
                'estado_qr'  => 'pending',
                'qr'         => null,
            ]);

            return response()->json([
                'message' => 'Nuevo QR generado',
                'account' => $account,
            ]);
        } catch (\Throwable $e) {
            Log::error('❌ regenerateQr: Error interno', [
                'message'    => $e->getMessage(),
                'session_id' => $validated['session_id'],
            ]);

            return response()->json([
                'error' => 'Error interno al regenerar QR',
            ], 500);
        }
    }

    /**
     * 🔁 Endpoint donde Node actualiza el estado de la sesión (USADO POR NODE)
     *
     * - Llega: session_id, estado_qr, (opcional) session_data
     * - Nunca responde 404 a Node para no disparar el Circuit Breaker.
     */
    public function updateStatus(Request $request)
    {
        $validated = $request->validate([
            'session_id'   => 'required|uuid',
            'estado_qr'    => 'required|string',
            'session_data' => 'nullable|array',
        ]);

        try {
            $account = WhatsappAccount::where('session_id', $validated['session_id'])
                ->first();

            if (!$account) {
                Log::warning('⚠️ updateStatus: Cuenta no encontrada para session_id', [
                    'session_id' => $validated['session_id'],
                ]);

                // Respondemos 200 para no romper integración con Node
                return response()->json([
                    'success' => true,
                    'skipped' => true,
                    'reason'  => 'account_not_found',
                ]);
            }

            $account->estado_qr = $validated['estado_qr'];

            if (!empty($validated['session_data'])) {
                $account->session_data = json_encode($validated['session_data']);
            }

            $account->save();

            Log::info('✅ updateStatus: Estado actualizado', [
                'session_id' => $validated['session_id'],
                'estado_qr'  => $validated['estado_qr'],
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Estado actualizado correctamente',
            ]);
        } catch (\Throwable $e) {
            Log::error('❌ updateStatus: Error interno', [
                'message'    => $e->getMessage(),
                'session_id' => $validated['session_id'],
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Error interno al actualizar el estado',
            ], 500);
        }
    }

    //actualiza el estado de varias cuentas en batch
    
    public function batchStatus(Request $request)
{
    $validated = $request->validate([
        'statuses' => 'required|array',
        'statuses.*.session_id' => 'required|uuid',
        'statuses.*.estado_qr'  => 'required|string',
    ]);

    foreach ($validated['statuses'] as $item) {
        WhatsappAccount::where('session_id', $item['session_id'])
            ->update([
                'estado_qr' => $item['estado_qr'],
            ]);

        Log::info('✅ batchStatus: estado actualizado', [
            'session_id' => $item['session_id'],
            'estado_qr'  => $item['estado_qr'],
        ]);
    }

    return response()->json([
        'success' => true,
        'message' => 'Batch actualizado correctamente',
    ]);
}


    /**
     * 📡 Devuelve las cuentas con status=active (usado por Node para restoreSessions)
     */
    public function active()
    {
        try {
            $accounts = WhatsappAccount::where('status', 'active')
                ->select('id', 'user_id', 'session_id', 'status', 'estado_qr', 'webhook_token')
                ->get();

            return response()->json($accounts);
        } catch (\Throwable $e) {
            Log::error('❌ active: Error al obtener cuentas activas', [
                'message' => $e->getMessage(),
            ]);

            return response()->json([
                'error'   => 'Error al obtener cuentas activas',
                'message' => $e->getMessage(),
            ], 500);
        }
    }

    /**
     * ➕ Crear una cuenta WhatsApp (panel)
     */
    public function store(Request $request)
    {
        $userId = Auth::id();

        if (!$userId) {
            return response()->json([
                'success' => false,
                'message' => 'Usuario no autenticado.',
            ], 401);
        }

        $existingAccount = WhatsappAccount::where('user_id', $userId)->first();
        if ($existingAccount) {
            return response()->json([
                'success' => false,
                'message' => 'Ya tienes una cuenta WhatsApp registrada',
            ], 422);
        }

        try {
            $validated = $request->validate([
                'name'                   => 'required|string|max:255',
                'phone_number'           => 'required|string|max:20|unique:whatsapp_accounts,phone_number',
                'phone_number_cuenta_id' => 'required|string|max:25|unique:whatsapp_accounts,phone_number_cuenta_id',
                'access_token'           => 'required|string|max:600',
                'status'                 => 'nullable|in:active,inactive',
                'phone_number_id'        => 'required|string|max:50',
                'plan_id'                => 'nullable|exists:plans,id',
            ]);

            $account = WhatsappAccount::create([
                'user_id'                 => $userId,
                'name'                    => $validated['name'],
                'phone_number'            => $validated['phone_number'],
                'phone_number_id'         => $validated['phone_number_id'],
                'phone_number_cuenta_id'  => $validated['phone_number_cuenta_id'],
                'access_token'            => $validated['access_token'],
                'status'                  => 'active',
            ]);

            // Configuración de Weaviate por defecto
            $account->weaviateConfig()->create([
                'weaviate_url' => env('WEAVIATE_DEFAULT_URL', 'http://localhost:8080'),
                'api_key'      => env('WEAVIATE_API_KEY'),
                'class_name'   => 'User_' . $account->id,
            ]);

            // Configuración de Bot
            BotSetting::create([
                'whatsapp_account_id' => $account->id,
                'user_id'             => $userId,
                'is_active'           => false,
            ]);

            // Suscripción / Plan
            $plan = Plan::find($request->input('plan_id', 1)); // plan trial por defecto
            $start = Carbon::now();
            $end   = $start->copy()->addDays($plan->duration_days);
            $nextPayment = $end;

            Subscription::create([
                'user_id'          => $userId,
                'plan_id'          => $plan->id,
                'start_date'       => $start,
                'end_date'         => $end,
                'status'           => 'activa',
                'renewal_type'     => 'manual',
                'next_payment_due' => $nextPayment,
                'is_active'        => true,
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Cuenta creada exitosamente',
                'data'    => $account,
            ], 201);
        } catch (\Throwable $e) {
            Log::error('❌ store: Error al crear cuenta WhatsApp', [
                'message' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Error al crear la cuenta: ' . $e->getMessage(),
            ], 500);
        }
    }

    /**
     * 👁 Mostrar una cuenta por session_id (frontend/debug)
     */
    public function show(string $sessionId)
    {
        $account = WhatsappAccount::where('session_id', $sessionId)->first();

        if (!$account) {
            return response()->json([
                'message' => 'Cuenta no encontrada',
            ], 404);
        }

        return response()->json($account);
    }
}
