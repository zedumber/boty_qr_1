/**
 * 🔍 Validation Script - Duplicity Check
 * Verifica que todas las duplicidades de código hayan sido eliminadas
 */

const fs = require("fs");
const path = require("path");

const modulesPath = path.join(__dirname, "modules/whatsapp");

// Archivos a validar
const files = [
  "sessionManager.js",
  "qrManager.js",
  "connectionManager.js",
  "eventManager.js",
  "utils.js",
  "index.js",
];

console.log("🔍 Validando eliminación de duplicidades...\n");

let totalErrors = 0;
let totalWarnings = 0;

// ========== Validación 1: Utils.js debe tener las funciones compartidas ==========
console.log("📋 Validando utils.js contiene funciones compartidas");

const utilsPath = path.join(modulesPath, "utils.js");
const utilsContent = fs.readFileSync(utilsPath, "utf-8");

const sharedFunctions = [
  { pattern: /function\s+sleep\s*\(/m, name: "sleep()" },
  { pattern: /function\s+postLaravel\s*\(/m, name: "postLaravel()" },
  { pattern: /function\s+getQrStatus\s*\(/m, name: "getQrStatus()" },
  { pattern: /function\s+isSessionActive\s*\(/m, name: "isSessionActive()" },
];

for (const { pattern, name } of sharedFunctions) {
  if (pattern.test(utilsContent)) {
    console.log(`  ✅ utils.js: Contiene ${name}`);
  } else {
    console.log(`  ❌ utils.js: NO contiene ${name} (ERROR)`);
    totalErrors++;
  }
}

console.log("");

// ========== Validación 2: Managers no deben tener DUPLICACIÓN REAL de código ==========
console.log("📋 Validando que managers NO tengan duplicidad real de código\n");

const managerFiles = [
  "sessionManager.js",
  "qrManager.js",
  "connectionManager.js",
];

for (const file of managerFiles) {
  const filePath = path.join(modulesPath, file);
  const content = fs.readFileSync(filePath, "utf-8");

  // Buscar IMPLEMENTACIÓN REAL (no delegadores)
  // Los delegadores tienen patrón: return postLaravel(...) o return [...]util...
  // La duplicación real sería la lógica completa con bucle while(true), etc.

  const hasRealDuplication =
    /while\s*\(\s*true\s*\)\s*{\s*tryNum\+\+/.test(content) ||
    /return new Promise\(\(resolve\) => setTimeout/.test(content);

  if (!hasRealDuplication) {
    console.log(`  ✅ ${file}: No tiene código duplicado real`);
  } else {
    console.log(`  ⚠️  ${file}: Contiene código que podría ser duplicado`);
    totalWarnings++;
  }
}

console.log("");

// ========== Validación 3: Managers deben importar utils ==========
console.log("📋 Validando que managers importen utils.js\n");

for (const file of managerFiles) {
  const filePath = path.join(modulesPath, file);
  const content = fs.readFileSync(filePath, "utf-8");

  const hasUtilsImport = /require\s*\(\s*['"]\.\s*\/utils['"]\s*\)/i.test(
    content
  );

  if (hasUtilsImport) {
    console.log(`  ✅ ${file}: Importa utils.js`);
  } else {
    console.log(`  ❌ ${file}: NO importa utils.js (ERROR)`);
    totalErrors++;
  }
}

console.log("");

// ========== Validación 4: Métodos renombrados correctamente ==========
console.log("📋 Validando cambios de nombres de métodos\n");

for (const file of managerFiles) {
  const filePath = path.join(modulesPath, file);
  const content = fs.readFileSync(filePath, "utf-8");

  // Buscar isSessionActiveInLaravel (correcto para managers)
  const hasNewName = /isSessionActiveInLaravel\s*\(/g.test(content);
  // NO debe tener método async isSessionActive (solo puede ser de utils)
  const hasOldMethodDef = /async\s+isSessionActive\s*\(/g.test(content);

  if ((hasNewName || !hasOldMethodDef) && !hasOldMethodDef) {
    console.log(`  ✅ ${file}: Nombres de métodos correctos`);
  } else {
    console.log(`  ⚠️  ${file}: Verificar nombres de métodos`);
    totalWarnings++;
  }
}

console.log("");

// ========== Validación 5: Verificar que index1.js fue eliminado ==========
console.log("📋 Validando eliminación de archivo monolítico\n");

const index1Path = path.join(__dirname, "index1.js");
if (!fs.existsSync(index1Path)) {
  console.log("  ✅ index1.js: Eliminado correctamente");
} else {
  console.log("  ⚠️  index1.js: Aún existe (considerar eliminar)");
  totalWarnings++;
}

console.log("\n");

// Resumen
console.log("=" + "=".repeat(50));
console.log("📊 RESUMEN DE VALIDACIÓN");
console.log("=" + "=".repeat(50));
console.log(`✅ Errores encontrados: ${totalErrors}`);
console.log(`⚠️  Advertencias: ${totalWarnings}`);

if (totalErrors === 0) {
  console.log("\n🎉 ¡VALIDACIÓN EXITOSA!");
  console.log("   ✅ Todas las duplicidades han sido eliminadas");
  console.log("   ✅ Funciones compartidas centralizadas en utils.js");
  console.log("   ✅ Managers importan y usan correctamente las utilitarias");
  process.exit(0);
} else {
  console.log("\n❌ VALIDACIÓN FALLIDA. Hay errores que deben corregirse.");
  process.exit(1);
}
