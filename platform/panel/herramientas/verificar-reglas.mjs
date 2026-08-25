/**
 * Verifica los hallazgos que deciden el diseño de la pantalla Reglas.
 *
 *   node --env-file=../../.env.local herramientas/verificar-reglas.mjs
 *
 * No es un test: es una foto de producción. Existe porque tres de las decisiones
 * de esa pantalla dependen de datos que no se pueden adivinar, y porque el
 * hallazgo más importante —que los límites y las direcciones están DUPLICADOS
 * dentro de los documentos indexados, y que es de ahí que salen— haría que la
 * pantalla mienta si no se lo dice al operador.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const titulo = (t) => console.log(`\n${"=".repeat(70)}\n${t}\n${"=".repeat(70)}`);

/* --- 1 · ¿El voto funcionó en producción? -------------------------------- */

titulo("1 · VOTOS REALES");

const { data: votos } = await supabase
  .from("valoraciones")
  .select("voto, comentario, creado_en, mensaje_id, conversacion_id")
  .order("creado_en", { ascending: false });

if (!votos || votos.length === 0) {
  console.log("  todavía nadie votó");
} else {
  for (const v of votos) {
    const { data: m } = await supabase
      .from("mensajes")
      .select("texto, origen_respuesta")
      .eq("id", v.mensaje_id)
      .single();
    console.log(`  ${v.voto === "util" ? "👍" : "👎"}  ${v.creado_en.slice(0, 16)}`);
    console.log(`      sobre: ${JSON.stringify((m?.texto ?? "").slice(0, 100))}`);
    console.log(`      origen: ${m?.origen_respuesta}`);
    if (v.comentario) console.log(`      dijo: ${JSON.stringify(v.comentario)}`);
    // El voto NUNCA tiene que estar colgado del «¿te sirvió?».
    if (/te sirvió/i.test(m?.texto ?? "")) {
      console.log("      *** MAL: el voto quedó pegado a la pregunta de cortesía ***");
    }
  }
}

/* --- 2 · EL HALLAZGO QUE DECIDE LA PANTALLA ------------------------------ */
//
// Si los límites y las direcciones están escritos DENTRO de los documentos
// indexados, entonces cambiarlos en Reglas no cambia lo que Migue contesta a una
// consulta libre: el modelo redacta con los fragmentos, no con la tabla.

titulo("2 · ¿LOS VALORES ESTÁN DUPLICADOS EN EL CORPUS INDEXADO?");

const { data: limites } = await supabase
  .from("limites_volumen")
  .select("categoria, limite_valor, limite_unidad, accion_al_exceder, activo")
  .order("categoria");

console.log("  limites_volumen (la tabla):");
for (const l of limites ?? []) {
  console.log(
    `    ${l.categoria.padEnd(13)} ${String(l.limite_valor).padStart(5)} ${l.limite_unidad.padEnd(7)} ` +
      `-> ${l.accion_al_exceder}${l.activo ? "" : "  (INACTIVO)"}`,
  );
}

const { data: puntos } = await supabase
  .from("puntos_verdes")
  .select("nombre, direccion, activo, orden")
  .order("orden");
console.log("\n  puntos_verdes (la tabla):");
for (const p of puntos ?? []) {
  console.log(`    ${(p.nombre ?? "—").padEnd(24)} ${p.direccion}${p.activo ? "" : "  (INACTIVO)"}`);
}

// Ahora: ¿esos mismos valores están adentro de los fragmentos que el modelo lee?
const BUSCAR = [
  ["direcciones de Puntos Verdes", ["Lamadrid 3700", "Viamonte e Italia", "Miguel Lillo"]],
  ["límites numéricos", ["LIMITE_ESCOMBROS", "LIMITE_PODA", "LIMITE_OTROS", "5 bolsas", "10 bolsas"]],
  ["días de zona", ["ZONA_NORTE", "ZONA_SUR", "Lunes, Martes, Viernes"]],
];

for (const [que, agujas] of BUSCAR) {
  const encontrados = new Set();
  for (const aguja of agujas) {
    const { data } = await supabase
      .from("fragmentos")
      .select("documento_id, texto")
      .ilike("texto", `%${aguja}%`)
      .limit(5);
    for (const f of data ?? []) encontrados.add(f.documento_id);
  }
  if (encontrados.size === 0) {
    console.log(`\n  ${que}: NO están en el corpus`);
  } else {
    const { data: docs } = await supabase
      .from("documentos")
      .select("titulo")
      .in("id", [...encontrados]);
    console.log(`\n  ${que}: SÍ, en ${encontrados.size} documento(s) indexado(s):`);
    for (const d of docs ?? []) console.log(`    - ${d.titulo}`);
  }
}

/* --- 3 · ¿Alguna respuesta real salió de los documentos? ----------------- */

titulo("3 · ¿EL BOT YA CONTESTÓ ESTOS DATOS DESDE LOS DOCUMENTOS?");

const { data: respuestas } = await supabase
  .from("mensajes")
  .select("texto, origen_respuesta, creado_en, conversacion_id")
  .eq("direccion", "saliente")
  .eq("origen_respuesta", "documentos")
  .order("creado_en", { ascending: false })
  .limit(10);

if (!respuestas || respuestas.length === 0) {
  console.log("  ninguna todavía");
} else {
  for (const r of respuestas) {
    // Qué preguntó el vecino justo antes.
    const { data: previo } = await supabase
      .from("mensajes")
      .select("texto")
      .eq("conversacion_id", r.conversacion_id)
      .eq("direccion", "entrante")
      .lt("creado_en", r.creado_en)
      .order("creado_en", { ascending: false })
      .limit(1);
    console.log(`  ${r.creado_en.slice(0, 16)}`);
    console.log(`    preguntó:  ${JSON.stringify(previo?.[0]?.texto ?? "—")}`);
    console.log(`    contestó:  ${JSON.stringify(r.texto.slice(0, 160))}`);
  }
}

/* --- 4 · Las claves de configuración, y quién las lee -------------------- */

titulo("4 · CONFIGURACION");

const { data: config } = await supabase
  .from("configuracion")
  .select("clave, valor, descripcion, actualizado_por, actualizado_en")
  .order("clave");

console.log(`  ${config?.length} claves\n`);
for (const c of config ?? []) {
  const v = JSON.stringify(c.valor);
  console.log(`  ${c.clave.padEnd(30)} ${v.length > 44 ? v.slice(0, 41) + "..." : v}`);
}
const editadas = (config ?? []).filter((c) => c.actualizado_por !== null);
console.log(`\n  editadas alguna vez desde el panel: ${editadas.length} de ${config?.length}`);

/* --- 5 · Exclusiones: qué acciones hay realmente ------------------------ */

titulo("5 · REGLAS DE EXCLUSION");

const { data: excl } = await supabase
  .from("reglas_exclusion")
  .select("nombre, palabras, accion, prioridad, activo, veces_aplicada")
  .order("prioridad");

for (const e of excl ?? []) {
  console.log(
    `  [${e.accion}] ${e.nombre.padEnd(28)} prio ${String(e.prioridad).padStart(3)}  ` +
      `${e.palabras.length} palabra(s)${e.activo ? "" : "  (INACTIVA)"}`,
  );
}
const advertir = (excl ?? []).filter((e) => e.accion === "advertir");
console.log(`\n  con accion='advertir' (que el orquestador ignora): ${advertir.length}`);

/* --- 6 · Zonas ---------------------------------------------------------- */

titulo("6 · ZONAS DE RECOLECCION");

const { data: zonas } = await supabase.from("zonas_recoleccion").select("*");
console.log(`  ${zonas?.length} fila(s)`);
for (const z of zonas ?? []) {
  console.log(`    ${JSON.stringify(z)}`);
}
