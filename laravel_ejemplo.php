<?php

namespace App\Http\Controllers;

use App\Models\WhatsappAccount;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth; // Asegúrate de tener este import arriba
use Illuminate\Validation\Rule;
use App\Models\WeaviateConfig;
use App\Models\BotSetting;
use Carbon\Carbon;
use App\Models\Plan;
use App\Models\Subscription;
use App\Models\User;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Http;


class WhatsappAccountController extends Controller
{
    
    
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
        'success' => true,
        'accounts' => $accounts
    ]);
}

// mandar getAccountBySession
public function getAccountBySession($sessionId)
{
    $account = WhatsappAccount::where('session_id', $sessionId)->first();

    if (!$account) {
        return response()->json([
            "status" => "inactive"
        ], 404);
    }

    return response()->json([
        "id"            => $account->id,
        "user_id"       => $account->user_id,
        "webhook_token" => $account->webhook_token,
        "status"        => $account->estado_qr ?? "inactive", // 👈 aquí mandas el status
    ]);
}

public function startSession(Request $request)
{
    $userId = auth()->id();

    if (!$userId) {
        return response()->json([
            'error' => 'Usuario no autenticado'
        ], 401);
    }

    // 🔍 Buscar la cuenta del usuario
    $account = WhatsappAccount::where('user_id', $userId)->first();

    // ⚡ Si no existe, la creamos con un webhook_token único
    if (!$account) {
        $account = WhatsappAccount::create([
            'user_id'       => $userId,
            'name'          => $request->input('name', 'Cuenta WhatsApp'),
            'session_id'    => null, // se llenará tras respuesta de Node
            'estado_qr'     => 'pending',
            'webhook_token' => \Str::uuid(),
        ]);
    }

    try {
        // 🚀 Llamamos al servidor Node y le enviamos el webhook_token
        $response = Http::post("http://boty_baileys_tran:4001/start", [
            'user_id'       => $userId,
            'webhook_token' => $account->webhook_token,
        ]);

    } catch (\Exception $e) {
        \Log::error('❌ Error conectando con servidor Node', [
            'error' => $e->getMessage()
        ]);
        return response()->json(["error" => "No se pudo conectar al servidor de WhatsApp"], 500);
    }

    if ($response->failed()) {
        return response()->json(["error" => "Fallo al iniciar sesión en Node"], 500);
    }

    // ✅ Obtener datos de Node
    $data = $response->json();

    if (!isset($data['session_id'])) {
        return response()->json(["error" => "No se recibió session_id de Node"], 500);
    }

    $sessionId = $data['session_id'];

    // 🧠 Actualizamos la cuenta
    $account->update([
        'session_id' => $sessionId,
        'estado_qr'  => 'pending',
    ]);

    \Log::info('✅ Sesión WhatsApp creada/actualizada', [
        'user_id'      => $userId,
        'session_id'   => $sessionId,
        'webhook_token'=> $account->webhook_token,
    ]);

    return response()->json([
        'success'       => true,
        'session_id'    => $sessionId,
        'webhook_token' => $account->webhook_token,
        'account'       => $account
    ]);
}

public function cuentas()
{
    $usuarios = User::with('whatsappAccount')->get();

    $result = $usuarios->map(function ($user) {
        return [
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'phone' => $user->phone,
            'whatsapp_account' => $user->whatsappAccount ? [
                'id' => $user->whatsappAccount->id,
                'phone_number' => $user->whatsappAccount->phone_number,
                'phone_number_id' => $user->whatsappAccount->phone_number_id,
            ] : null,
        ];
    });

    return response()->json([
        'success' => true,
        'data' => $result,
    ]);
}


public function checkStatus($sessionId)
{
    $account = WhatsappAccount::where('session_id', $sessionId)->first();
    
    if (!$account) {
        return response()->json(['error' => 'Cuenta no encontrada'], 404);
    }

    return response()->json([
        'estado_qr' => $account->estado_qr,
        'status' => $account->status
    ]);
}

  //recive el qr 
 public function saveQr(Request $request)
    {
        $validated = $request->validate([
            'session_id' => 'required|uuid',
            'qr' => 'required|string'
        ]);

        $account = WhatsappAccount::where('session_id', $validated['session_id'])->firstOrFail();

        $account->update([
            'qr' => $validated['qr'],
            'estado_qr' => 'pending'
        ]);

        
        return response()->json([
            'message' => 'QR guardado correctamente',
            'account' => $account
        ]);
    }    

     // Obtener QR para frontend
    public function getQr($session_id)
    {
        $account = WhatsappAccount::where('session_id', $session_id)->first();

        if (!$account || !$account->qr) {
            return response()->json(['error' => 'QR no encontrado'], 404);
        }

        return response()->json([
            'qr' => $account->qr,
            'estado_qr' => $account->estado_qr,
        ]);
    }


   public function regenerateQr(Request $request)
{
    $validated = $request->validate([
        'session_id' => 'required|uuid',
    ]);

    // Buscar la cuenta correspondiente
    $account = WhatsappAccount::where('session_id', $validated['session_id'])->firstOrFail();

    try {
        // 🚀 Llamar a Node para reiniciar la sesión (usando el webhook_token)
        $response = Http::post("http://boty_baileys_tran:4001/start", [
        // $response = Http::post("http://localhost:4000/start", [
            'user_id'       => auth()->id(),
            'webhook_token' => $account->webhook_token,
        ]);

        if ($response->failed()) {
            return response()->json(['error' => 'No se pudo regenerar el QR'], 500);
        }

        $data = $response->json();
        $sessionId = $data['session_id'] ?? $account->webhook_token;

        // 🧠 Actualizar en la base de datos
        $account->update([
            'session_id' => $sessionId,
            'estado_qr'  => 'pending',
            'qr'         => null,
        ]);

        return response()->json([
            'message' => 'Nuevo QR generado correctamente',
            'account' => $account,
        ]);
    } catch (\Exception $e) {
        \Log::error('❌ Error regenerando QR', ['error' => $e->getMessage()]);
        return response()->json(['error' => 'Error regenerando QR: ' . $e->getMessage()], 500);
    }
}

   
public function updateStatus(Request $request)
{
    \Log::info('📥 Llamada recibida en updateStatus', [
        'body' => $request->all(),
        'headers' => $request->headers->all(),
        'url' => $request->fullUrl(),
    ]);

    $validated = $request->validate([
        'session_id'     => 'nullable|uuid',
        'webhook_token'  => 'nullable|uuid',
        'estado_qr'      => 'required|string',
        'session_data'   => 'nullable|array',
    ]);

    // Buscar por webhook_token o por session_id
    $account = WhatsappAccount::where(function ($query) use ($validated) {
        if (!empty($validated['webhook_token'])) {
            $query->where('webhook_token', $validated['webhook_token']);
        } elseif (!empty($validated['session_id'])) {
            $query->where('session_id', $validated['session_id']);
        }
    })->firstOrFail();

    // Actualizar estado y credenciales
    $account->estado_qr = $validated['estado_qr'];

    if ($request->has('session_data')) {
        $account->session_data = json_encode($validated['session_data']);
    }

    $account->save();

    \Log::info('✅ Estado/credenciales actualizados correctamente', [
        'session_id' => $account->session_id,
        'webhook_token' => $account->webhook_token,
        'estado_qr' => $account->estado_qr,
    ]);

    return response()->json([
        'message' => 'Estado actualizado correctamente',
        'account' => $account,
    ]);
}

 public function active()
    {
        try {
            // filtras solo las cuentas que están activas
            $accounts = WhatsappAccount::where('status', 'active')->get();

            return response()->json($accounts);
        } catch (\Exception $e) {
            return response()->json([
                'error' => 'Error al obtener cuentas activas',
                'message' => $e->getMessage()
            ], 500);
        }
    }


public function store(Request $request)
{    
    $userId = auth()->id();
      $existingAccount = WhatsappAccount::where('user_id', $userId)->first();
        if ($existingAccount) {
        return response()->json([
            'success' => false,
            'message' => 'Ya tienes una cuenta WhatsApp registrada'
        ], 422);
    }if (!$userId) {
        return response()->json([
            'success' => false,
            'message' => 'Usuario no autenticado.'
        ], 401);
    }
    try {
        $validated = $request->validate([
            'name' => 'required|string|max:255',
            'phone_number' => 'required|string|max:20|unique:whatsapp_accounts,phone_number',
            'phone_number_cuenta_id' => 'required|string|max:25|unique:whatsapp_accounts,phone_number_cuenta_id',
            'access_token' => 'required|string|max:600',
            'status' => 'nullable|in:active,inactive',
            'phone_number_id' => 'required|string|max:50',
        ]);

        $account = WhatsappAccount::create([
            'user_id' => $userId,
            'name' => $validated['name'],
            'phone_number' => $validated['phone_number'],
            'phone_number_id' => $validated['phone_number_id'],
            'phone_number_cuenta_id' => $validated['phone_number_cuenta_id'],
            'access_token' => $validated['access_token'],
            'status' => 'active',
        ]);

        $account->weaviateConfig()->create([
       'weaviate_url' => env('WEAVIATE_DEFAULT_URL', 'http://localhost:8080'),
       'api_key' => env('WEAVIATE_API_KEY'), // si aplica
       'class_name' => 'User_' . $account->id, // personalizado por cuenta
        ]);

        BotSetting::create([
         'whatsapp_account_id' => $account->id,
            'user_id' => $userId,
             'is_active' => false
                ]);
    $plan = Plan::find($request->input('plan_id', 1)); // 1 = plan trial de 7 días     
        // 2) Defino fechas
    $start = Carbon::now();
    // end_date = start + duración del plan (en días)
    $end = $start->copy()->addDays($plan->duration_days);
    // next_payment_due = cuando quieras hacer el primer cobro.
    // Si es trial de 7 días, igual que end_date, sino quizás start+7
    $nextPayment = $end;

    // 3) Creo la suscripción
    $subscription = Subscription::create([
        'user_id'          => auth()->id(),
        'plan_id'          => $plan->id,
        'start_date'       => $start,
        'end_date'         => $end,
        'status'           => 'activa',               // arranca activa
        'renewal_type'     => 'manual',           // o 'manual' según tu lógica
        'next_payment_due' => $nextPayment,   // Próximo pago
        'is_active'        => true,
    ]);
   

        return response()->json([
            'success' => true,
            'message' => 'Cuenta creada exitosamente',
            'data' => $account
        ], 201);

    } catch (\Exception $e) {
        return response()->json([
            'success' => false,
            'message' => 'Error al crear la cuenta: ' . $e->getMessage()
        ], 500);
    }
}



     public function show($sessionId)
    {
        $account = WhatsappAccount::where('session_id', $sessionId)->first();

        if (!$account) {
            return response()->json([
                'message' => 'Cuenta no encontrada',
            ], 404);
        }

        return response()->json($account);
    }

//    
}
