/**
 * 🧪 Test Rápido - Validar Estructura Modular
 *
 * Ejecutar: node test-modular-structure.js
 *
 * Valida que todos los módulos existen y se pueden importar
 */

const fs = require("fs");
const path = require("path");

console.log("\n🧪 Iniciando validación de estructura modular...\n");

// Colores para terminal
const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

function check(condition, message) {
  const status = condition ? colors.green + "✅" : colors.red + "❌";
  console.log(`${status}${colors.reset} ${message}`);
  return condition;
}

function checkFile(filePath) {
  const exists = fs.existsSync(filePath);
  const relPath = path.relative(process.cwd(), filePath);
  return check(exists, `Archivo existe: ${relPath}`);
}

function checkFileReadable(filePath) {
  try {
    fs.readFileSync(filePath, "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

function getFileLines(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return content.split("\n").length;
}

let passed = 0;
let failed = 0;

// ============================================================================
// 1. Validar archivos del módulo whatsapp/
// ============================================================================
console.log(
  `${colors.yellow}=== 1. Archivos del Módulo WhatsApp ===${colors.reset}\n`
);

const whatsappFiles = {
  "modules/whatsapp/index.js": "Fachada unificada",
  "modules/whatsapp/sessionManager.js": "Gestión de sesiones",
  "modules/whatsapp/qrManager.js": "Manejo de QR codes",
  "modules/whatsapp/connectionManager.js": "Manejo de conexiones",
  "modules/whatsapp/eventManager.js": "Orquestación de eventos",
};

Object.entries(whatsappFiles).forEach(([file, desc]) => {
  const fullPath = path.join(__dirname, file);
  const exists = checkFile(fullPath);
  if (exists) {
    const lines = getFileLines(fullPath);
    console.log(`   └─ ${desc} (${lines} líneas)`);
    passed++;
  } else {
    failed++;
  }
});

// ============================================================================
// 2. Validar que los archivos se pueden importar
// ============================================================================
console.log(
  `\n${colors.yellow}=== 2. Importabilidad de Módulos ===${colors.reset}\n`
);

try {
  const SessionManager = require("./modules/whatsapp/sessionManager");
  check(SessionManager, "SessionManager se puede importar");
  passed++;
} catch (e) {
  check(false, `SessionManager: ${e.message}`);
  failed++;
}

try {
  const QRManager = require("./modules/whatsapp/qrManager");
  check(QRManager, "QRManager se puede importar");
  passed++;
} catch (e) {
  check(false, `QRManager: ${e.message}`);
  failed++;
}

try {
  const ConnectionManager = require("./modules/whatsapp/connectionManager");
  check(ConnectionManager, "ConnectionManager se puede importar");
  passed++;
} catch (e) {
  check(false, `ConnectionManager: ${e.message}`);
  failed++;
}

try {
  const EventManager = require("./modules/whatsapp/eventManager");
  check(EventManager, "EventManager se puede importar");
  passed++;
} catch (e) {
  check(false, `EventManager: ${e.message}`);
  failed++;
}

try {
  const WhatsAppManager = require("./modules/whatsapp");
  check(WhatsAppManager, "WhatsAppManager (fachada) se puede importar");
  passed++;
} catch (e) {
  check(false, `WhatsAppManager: ${e.message}`);
  failed++;
}

// ============================================================================
// 3. Validar estructura de clases
// ============================================================================
console.log(
  `\n${colors.yellow}=== 3. Estructura de Clases ===${colors.reset}\n`
);

try {
  const SessionManager = require("./modules/whatsapp/sessionManager");
  const methods = [
    "startSession",
    "deleteSession",
    "restoreSessions",
    "getSessionInfo",
    "listActiveSessions",
    "getSessionStats",
    "closeAllSessions",
    "isSessionActive",
  ];

  const hasAll = methods.every(
    (m) => typeof SessionManager.prototype[m] === "function"
  );
  check(hasAll, `SessionManager tiene todos los métodos (${methods.length})`);
  if (hasAll) passed++;
  else failed++;
} catch (e) {
  check(false, `Error validando SessionManager: ${e.message}`);
  failed++;
}

try {
  const QRManager = require("./modules/whatsapp/qrManager");
  const methods = [
    "handleQrCode",
    "setupQrExpiration",
    "clearQrState",
    "getQRStats",
  ];

  const hasAll = methods.every(
    (m) => typeof QRManager.prototype[m] === "function"
  );
  check(hasAll, `QRManager tiene todos los métodos (${methods.length})`);
  if (hasAll) passed++;
  else failed++;
} catch (e) {
  check(false, `Error validando QRManager: ${e.message}`);
  failed++;
}

try {
  const ConnectionManager = require("./modules/whatsapp/connectionManager");
  const methods = [
    "onSessionOpen",
    "onSessionClose",
    "handleSessionOpen",
    "handleSessionClose",
    "handleConnectionUpdate",
  ];

  const hasAll = methods.every(
    (m) => typeof ConnectionManager.prototype[m] === "function"
  );
  check(
    hasAll,
    `ConnectionManager tiene todos los métodos (${methods.length})`
  );
  if (hasAll) passed++;
  else failed++;
} catch (e) {
  check(false, `Error validando ConnectionManager: ${e.message}`);
  failed++;
}

try {
  const EventManager = require("./modules/whatsapp/eventManager");
  const methods = ["registerSessionEvents", "unregisterSessionEvents"];

  const hasAll = methods.every(
    (m) => typeof EventManager.prototype[m] === "function"
  );
  check(hasAll, `EventManager tiene todos los métodos (${methods.length})`);
  if (hasAll) passed++;
  else failed++;
} catch (e) {
  check(false, `Error validando EventManager: ${e.message}`);
  failed++;
}

try {
  const WhatsAppManager = require("./modules/whatsapp");
  const methods = [
    "startSession",
    "deleteSession",
    "restoreSessions",
    "getSessionInfo",
    "listActiveSessions",
    "closeAllSessions",
    "getStats",
    "onSessionOpen",
    "onSessionClose",
  ];

  const hasAll = methods.every(
    (m) => typeof WhatsAppManager.prototype[m] === "function"
  );
  check(
    hasAll,
    `WhatsAppManager (fachada) tiene todos los métodos (${methods.length})`
  );
  if (hasAll) passed++;
  else failed++;
} catch (e) {
  check(false, `Error validando WhatsAppManager: ${e.message}`);
  failed++;
}

// ============================================================================
// 4. Validar documentación
// ============================================================================
console.log(`\n${colors.yellow}=== 4. Documentación ===${colors.reset}\n`);

const docFiles = {
  "ARCHITECTURE_MODULAR.md": "Arquitectura técnica",
  "ANALYSIS_REFACTORING.md": "Análisis de cambios",
  "EXAMPLES_USAGE.js": "Ejemplos prácticos",
  "SUMMARY_REFACTORING.md": "Resumen visual",
  "DIAGRAMS_ARCHITECTURE.md": "Diagramas ASCII",
  "README_MODULAR.md": "Guía rápida",
  "MIGRATION_GUIDE.md": "Migración paso a paso",
  "CHECKLIST_VALIDATION.md": "Checklist de validación",
  "EXECUTIVE_SUMMARY.md": "Resumen ejecutivo",
};

Object.entries(docFiles).forEach(([file, desc]) => {
  const fullPath = path.join(__dirname, file);
  const exists = checkFile(fullPath);
  if (exists) {
    const lines = getFileLines(fullPath);
    console.log(`   └─ ${desc} (${lines} líneas)`);
    passed++;
  } else {
    failed++;
  }
});

// ============================================================================
// 5. Validar cambios en index.js
// ============================================================================
console.log(
  `\n${colors.yellow}=== 5. Cambios en index.js ===${colors.reset}\n`
);

try {
  const indexContent = fs.readFileSync(
    path.join(__dirname, "index.js"),
    "utf8"
  );
  const hasNewImport = indexContent.includes("require('./modules/whatsapp')");
  const noOldImport = !indexContent.includes(
    "require('./modules/whatsappManager')"
  );

  check(hasNewImport, "index.js importa de './modules/whatsapp'");
  if (hasNewImport) passed++;
  else failed++;

  check(
    noOldImport,
    "index.js NO importa de './modules/whatsappManager' (deprecated)"
  );
  if (noOldImport) passed++;
  else failed++;
} catch (e) {
  check(false, `Error validando index.js: ${e.message}`);
  failed += 2;
}

// ============================================================================
// Resultado Final
// ============================================================================
console.log(`\n${colors.yellow}=== Resultado Final ===${colors.reset}\n`);

const total = passed + failed;
console.log(
  `Pruebas pasadas: ${colors.green}${passed}${colors.reset}/${total}`
);
console.log(`Pruebas fallidas: ${colors.red}${failed}${colors.reset}/${total}`);

if (failed === 0) {
  console.log(
    `\n${colors.green}✅ ¡TODAS LAS VALIDACIONES PASARON!${colors.reset}`
  );
  console.log("\nTu estructura modular está lista para uso.");
  console.log("Próximo paso: Leer README_MODULAR.md\n");
  process.exit(0);
} else {
  console.log(
    `\n${colors.red}❌ Hay ${failed} validación(es) que no pasaron.${colors.reset}`
  );
  console.log("Verifica los archivos mencionados arriba.\n");
  process.exit(1);
}
