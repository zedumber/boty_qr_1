# 🚀 Script de Migración - De index.js a index_new.js

# Colores para output
$GREEN = "Green"
$YELLOW = "Yellow"
$RED = "Red"
$CYAN = "Cyan"

function Write-ColorOutput($ForegroundColor) {
    $fc = $host.UI.RawUI.ForegroundColor
    $host.UI.RawUI.ForegroundColor = $ForegroundColor
    if ($args) {
        Write-Output $args
    }
    $host.UI.RawUI.ForegroundColor = $fc
}

Write-ColorOutput $CYAN "=========================================="
Write-ColorOutput $CYAN "   WhatsApp Server - Script de Migración"
Write-ColorOutput $CYAN "=========================================="
Write-Host ""

# Verificar que estamos en el directorio correcto
if (-Not (Test-Path "package.json")) {
    Write-ColorOutput $RED "❌ Error: No se encuentra package.json"
    Write-ColorOutput $YELLOW "   Por favor ejecuta este script desde el directorio raíz del proyecto"
    exit 1
}

Write-ColorOutput $GREEN "✅ Directorio de proyecto encontrado"
Write-Host ""

# 1. Backup del index.js actual
Write-ColorOutput $CYAN "📦 Paso 1: Creando backup de index.js..."
if (Test-Path "index.js") {
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    Copy-Item "index.js" "index_backup_$timestamp.js"
    Write-ColorOutput $GREEN "   ✅ Backup creado: index_backup_$timestamp.js"
} else {
    Write-ColorOutput $YELLOW "   ⚠️  index.js no encontrado (primera instalación)"
}
Write-Host ""

# 2. Verificar estructura de módulos
Write-ColorOutput $CYAN "📁 Paso 2: Verificando estructura de módulos..."

$requiredDirs = @("modules", "utils", "config")
$allDirsExist = $true

foreach ($dir in $requiredDirs) {
    if (Test-Path $dir) {
        Write-ColorOutput $GREEN "   ✅ $dir/"
    } else {
        Write-ColorOutput $RED "   ❌ $dir/ no encontrado"
        $allDirsExist = $false
    }
}

if (-Not $allDirsExist) {
    Write-ColorOutput $RED "❌ Faltan directorios requeridos"
    Write-ColorOutput $YELLOW "   Asegúrate de que todos los módulos estén creados"
    exit 1
}
Write-Host ""

# 3. Verificar archivos de módulos
Write-ColorOutput $CYAN "📄 Paso 3: Verificando archivos de módulos..."

$requiredFiles = @(
    "modules/messageReceiver.js",
    "modules/messageSender.js",
    "modules/queueManager.js",
    "modules/whatsappManager.js",
    "utils/lidResolver.js",
    "utils/logger.js",
    "config/config.js",
    "index_new.js"
)

$allFilesExist = $true

foreach ($file in $requiredFiles) {
    if (Test-Path $file) {
        Write-ColorOutput $GREEN "   ✅ $file"
    } else {
        Write-ColorOutput $RED "   ❌ $file no encontrado"
        $allFilesExist = $false
    }
}

if (-Not $allFilesExist) {
    Write-ColorOutput $RED "❌ Faltan archivos requeridos"
    exit 1
}
Write-Host ""

# 4. Verificar dependencias
Write-ColorOutput $CYAN "📦 Paso 4: Verificando dependencias de Node.js..."

$packageJson = Get-Content "package.json" | ConvertFrom-Json
$requiredDeps = @("express", "axios", "@whiskeysockets/baileys", "bull", "ioredis", "uuid")

foreach ($dep in $requiredDeps) {
    if ($packageJson.dependencies.PSObject.Properties.Name -contains $dep) {
        Write-ColorOutput $GREEN "   ✅ $dep"
    } else {
        Write-ColorOutput $RED "   ❌ $dep no encontrado en package.json"
    }
}
Write-Host ""

# 5. Test de sintaxis
Write-ColorOutput $CYAN "🔍 Paso 5: Verificando sintaxis de index_new.js..."

$syntaxCheck = node --check index_new.js 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-ColorOutput $GREEN "   ✅ Sintaxis correcta"
} else {
    Write-ColorOutput $RED "   ❌ Error de sintaxis en index_new.js"
    Write-ColorOutput $YELLOW "   $syntaxCheck"
    exit 1
}
Write-Host ""

# 6. Crear directorios necesarios
Write-ColorOutput $CYAN "📁 Paso 6: Creando directorios necesarios..."

$dirs = @("auth", "audios")
foreach ($dir in $dirs) {
    if (-Not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
        Write-ColorOutput $GREEN "   ✅ Creado: $dir/"
    } else {
        Write-ColorOutput $YELLOW "   ⚠️  Ya existe: $dir/"
    }
}
Write-Host ""

# 7. Verificar configuración
Write-ColorOutput $CYAN "⚙️  Paso 7: Verificando configuración..."

Write-ColorOutput $YELLOW "   Por favor revisa config/config.js y ajusta:"
Write-Host "   - laravelApi: URL de tu backend Laravel"
Write-Host "   - redisHost: Host de Redis (localhost o nombre de contenedor Docker)"
Write-Host "   - port: Puerto del servidor (default: 4000)"
Write-Host ""

# 8. Instrucciones finales
Write-ColorOutput $CYAN "=========================================="
Write-ColorOutput $GREEN "✅ Verificación completada exitosamente"
Write-ColorOutput $CYAN "=========================================="
Write-Host ""

Write-ColorOutput $YELLOW "📋 PRÓXIMOS PASOS:"
Write-Host ""
Write-Host "1. Revisa y ajusta la configuración:"
Write-ColorOutput $CYAN "   notepad config/config.js"
Write-Host ""
Write-Host "2. Inicia el servidor con la nueva versión:"
Write-ColorOutput $CYAN "   node index_new.js"
Write-Host ""
Write-Host "3. En otra terminal, verifica el health check:"
Write-ColorOutput $CYAN "   curl http://localhost:4000/health"
Write-Host ""
Write-Host "4. Una vez validado, reemplaza index.js:"
Write-ColorOutput $CYAN "   Copy-Item index_new.js index.js -Force"
Write-Host ""
Write-Host "5. Si usas PM2, reinicia el servicio:"
Write-ColorOutput $CYAN "   pm2 restart whatsapp-server"
Write-Host ""

Write-ColorOutput $YELLOW "📚 Documentación:"
Write-Host "   - README.md: Guía completa"
Write-Host "   - COMPARISON.md: Diferencias entre versiones"
Write-Host "   - ARCHITECTURE.md: Diagramas y flujos"
Write-Host ""

Write-ColorOutput $GREEN "🎉 ¡Listo para migrar!"
