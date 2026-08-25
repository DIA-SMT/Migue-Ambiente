/**
 * Ejercita la pantalla Reglas contra datos reales.
 *
 *   node --env-file=../../.env.local herramientas/verificar-pantalla-reglas.mjs
 *
 * Lo que prueba no es que compile —eso lo dice `tsc`— sino que las 19 claves de
 * producción tengan una definición en la pantalla, que la validación acepte los
 * valores que HOY están guardados, y que los dos probadores devuelvan lo mismo
 * que va a hacer el bot.
 *
 * El primero de esos tres es el que importa: si una clave de la base no tiene
 * definición, la pantalla la muestra de sólo lectura y nadie puede corregirla
 * cuando esté mal. Y si una definición valida MAL un valor que ya está guardado,
 * el operador abre la pantalla y ve un error rojo sobre algo que funciona.
 */
import { createClient } from "@supabase/supabase-js";
import { DEFINICIONES, aTexto, validarValor } from "../src/lib/reglas.ts";
import {
  esUtilizable,
  evaluarTodasLasExclusiones,
  interpretarCantidad,
  limiteDe,
  validarVolumen,
} from "@migue/dominio";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let fallas = 0;
const mal = (m) => {
  console.log(`  MAL  ${m}`);
  fallas++;
};
const bien = (m) => console.log(`  ok   ${m}`);

/* --- 1 · Toda clave de la base tiene definición en la pantalla ----------- */

const { data: config } = await supabase.from("configuracion").select("clave, valor").order("clave");

const sinDefinir = (config ?? []).filter((c) => !DEFINICIONES.has(c.clave));
if (sinDefinir.length > 0) {
  mal(`${sinDefinir.length} clave(s) de la base sin describir: ${sinDefinir.map((c) => c.clave).join(", ")}`);
} else {
  bien(`las ${config.length} claves de producción tienen definición`);
}

// Y al revés: una definición que apunta a una clave inexistente sería un control
// que la pantalla muestra y la base no tiene.
const enBase = new Set((config ?? []).map((c) => c.clave));
const inventadas = [...DEFINICIONES.keys()].filter((k) => !enBase.has(k));
if (inventadas.length > 0) mal(`la pantalla describe claves que no existen: ${inventadas.join(", ")}`);
else bien("ninguna definición apunta a una clave inexistente");

/* --- 2 · La validación acepta lo que YA está guardado -------------------- */

let rechazados = 0;
for (const c of config ?? []) {
  const def = DEFINICIONES.get(c.clave);
  if (!def) continue;
  const texto = aTexto(def, c.valor);
  const v = validarValor(def, texto);
  if (!v.ok) {
    mal(`«${c.clave}» tiene guardado ${JSON.stringify(c.valor)} y la pantalla lo rechaza: ${v.mensaje}`);
    rechazados++;
  }
}
if (rechazados === 0) bien("la validación acepta los 19 valores que hay guardados hoy");

/* --- 3 · La validación rechaza lo que rompe al bot ---------------------- */
//
// Cada uno de estos es un valor que, si se guardara, produce un error EN LA CARA
// del vecino. Si la pantalla los aceptara, no serviría de nada.

const DEBEN_FALLAR = [
  ["sla_modo", "dias_corridos", "un modo que no existe hace que el bot se caiga en el último paso"],
  ["sla_modo", "", "vacío"],
  ["sla_horas_habiles", "setenta y dos", "no numérico da «NaN días hábiles»"],
  ["sla_horas_habiles", "0", "cero"],
  ["sla_horas_habiles", "-5", "negativo"],
  ["umbral_confianza", "1.5", "fuera de 0 a 1"],
  ["umbral_confianza", "abc", "no numérico"],
  ["feriados", "2026-13-01", "mes 13"],
  ["feriados", "2026-02-30", "30 de febrero: pasa la expresión regular y no es un día"],
  ["feriados", "25/12/2026", "formato con barras"],
  ["max_fragmentos_contexto", "0", "cero fragmentos"],
  ["sla_jornada_desde", "25", "hora 25"],
  ["modelo_respuesta", "", "vacío"],
  ["empresa_recoleccion", "   ", "sólo espacios"],
];

let colados = 0;
for (const [clave, valor, porque] of DEBEN_FALLAR) {
  const def = DEFINICIONES.get(clave);
  if (!def) {
    mal(`no hay definición de ${clave} para probar`);
    continue;
  }
  const v = validarValor(def, valor);
  if (v.ok) {
    mal(`la pantalla ACEPTA ${clave}=${JSON.stringify(valor)} — ${porque}`);
    colados++;
  }
}
if (colados === 0) bien(`los ${DEBEN_FALLAR.length} valores que rompen al bot se rechazan`);

/* --- 4 · Y acepta los válidos ------------------------------------------- */

const DEBEN_PASAR = [
  ["sla_modo", "horas_corridas"],
  ["sla_horas_habiles", "48"],
  ["umbral_confianza", "0,55"], // con coma, que es como se escribe acá
  ["umbral_confianza", "0.55"],
  ["feriados", "2026-12-25\n2026-01-01"],
  ["feriados", ""], // vacío = sin feriados, es válido
  ["sla_sabado_habil", "false"],
];

let falsosRechazos = 0;
for (const [clave, valor] of DEBEN_PASAR) {
  const v = validarValor(DEFINICIONES.get(clave), valor);
  if (!v.ok) {
    mal(`la pantalla rechaza un valor válido: ${clave}=${JSON.stringify(valor)} — ${v.mensaje}`);
    falsosRechazos++;
  }
}
if (falsosRechazos === 0) bien(`los ${DEBEN_PASAR.length} valores válidos se aceptan`);

/* --- 5 · El probador de exclusiones, contra las reglas reales ------------ */

const { data: reglas } = await supabase.from("reglas_exclusion").select("*").order("prioridad");
const comoDominio = (reglas ?? []).map((f) => ({
  id: f.id,
  nombre: f.nombre,
  palabras: f.palabras,
  organismo: f.organismo,
  respuesta: f.respuesta,
  accion: f.accion,
  prioridad: f.prioridad,
  activa: f.activa,
}));

console.log();
console.log("  PROBADOR DE EXCLUSIONES (con la función real del bot):");

const CASOS = [
  ["hay olor a gas en la esquina", "Fuga de gas", true],
  ["se me rompio el medidor", "Fuga de gas", true],
  // La razón de ser del probador propio: `probar_disparadores` compara por
  // subcadena y estas tres darían falsos positivos con la palabra «gas».
  ["el desgaste del pavimento", null, false],
  ["quiero saber sobre residuos gaseosos", null, false],
  ["necesito que retiren escombros", null, false],
  ["quiero denunciar a mi vecino que tira basura", "Infracciones de vecinos o vehiculos", true],
  ["hay neumaticos tirados", "Neumaticos", true],
  // Plural automático: la tabla tiene «neumatico» y «neumaticos», pero el
  // sufijo opcional tiene que funcionar igual.
  ["encontre una cubierta", "Neumaticos", true],
];

for (const [texto, esperado, deberiaCoincidir] of CASOS) {
  const c = evaluarTodasLasExclusiones(texto, comoDominio);
  const primera = c[0]?.regla.nombre ?? null;
  const ok = deberiaCoincidir ? primera === esperado : c.length === 0;
  console.log(
    `    ${ok ? "ok  " : "MAL "} ${JSON.stringify(texto).padEnd(48)} -> ${primera ?? "(ninguna)"}` +
      (c.length > 1 ? `  [+${c.length - 1} más]` : ""),
  );
  if (!ok) {
    fallas++;
    console.log(`         esperaba: ${esperado ?? "(ninguna)"}`);
  }
}

/* --- 6 · El simulador de volumen, contra los límites reales ------------- */

const { data: lim } = await supabase.from("limites_volumen").select("*");
const limitesDominio = (lim ?? []).map((f) => ({
  categoria: f.categoria,
  etiqueta: f.etiqueta,
  limiteValor: Number(f.limite_valor),
  limiteUnidad: f.limite_unidad,
  pesoMaxBolsaKg: f.peso_max_bolsa_kg,
  accionAlExceder: f.accion_al_exceder,
  textoExceso: f.texto_exceso,
  palabras: f.palabras,
  activo: f.activo,
}));

console.log();
console.log("  SIMULADOR DE VOLUMEN (con la función real del bot):");

for (const [cat, frase] of [
  ["escombros", "3 bolsas"],
  ["escombros", "5 bolsas"],
  ["escombros", "20 bolsas"],
  ["poda", "2 bolsas"],
  ["poda", "15 bolsas"],
  ["voluminosos", "1 sillon"],
  ["voluminosos", "media camionada"],
  ["voluminosos", "30 bolsas"],
  ["escombros", "un poco"],
]) {
  const limite = limiteDe(cat, limitesDominio);
  if (!limite) {
    console.log(`    ${cat}: sin límite activo`);
    continue;
  }
  const cant = interpretarCantidad(frase);
  if (!esUtilizable(cant)) {
    console.log(`    ${cat.padEnd(12)} ${frase.padEnd(18)} -> repregunta (no entendió la cantidad)`);
    continue;
  }
  const r = validarVolumen(cant, limite);
  const extra =
    r.tipo === "precisar" ? `  motivo: ${r.motivo}` : r.convertido ? "  (convertido de unidad)" : "";
  console.log(`    ${cat.padEnd(12)} ${frase.padEnd(18)} -> ${r.tipo}${extra}`);
}

console.log();
console.log(fallas === 0 ? "TODO OK" : `${fallas} PROBLEMA(S)`);
process.exit(fallas === 0 ? 0 : 1);
