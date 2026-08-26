/**
 * La foto que necesita la pantalla Métricas para no mentir.
 *
 *   node --env-file=../../.env.local herramientas/foto-metricas.mjs
 *
 * Lo que importa acá no son los totales: es cuántas PERSONAS distintas hay
 * detrás. Si todas las conversaciones son de la misma cuenta —hoy es así, la del
 * desarrollador probando— entonces cualquier tasa que la pantalla calcule
 * describe al desarrollador, no a los vecinos. Un «78% le sirvió» sobre nueve
 * turnos de una sola persona es peor que no mostrar nada, porque parece una
 * medición.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const titulo = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

/* --- Cuánta gente, no cuántos mensajes --------------------------------- */

titulo("¿A CUÁNTA GENTE ATENDIÓ?");

const { data: convs } = await supabase
  .from("conversaciones")
  .select("id, canal, canal_usuario_id, nombre_usuario, estado, cantidad_mensajes, iniciada_en, ultima_actividad_en")
  .order("iniciada_en");

const personas = new Map();
for (const c of convs ?? []) {
  const k = `${c.canal}:${c.canal_usuario_id}`;
  personas.set(k, (personas.get(k) ?? 0) + 1);
}

console.log(`  conversaciones: ${convs?.length ?? 0}`);
console.log(`  personas distintas: ${personas.size}`);
for (const [k, n] of personas) {
  const nombre = convs?.find((c) => `${c.canal}:${c.canal_usuario_id}` === k)?.nombre_usuario;
  console.log(`    ${k}  ${n} conversación(es)  ${nombre ?? "sin nombre"}`);
}
if (personas.size <= 1) {
  console.log("\n  *** Con una sola persona, NINGUNA tasa describe a vecinos reales. ***");
}

// Conversaciones que quedaron 'abierta' y nadie va a volver. Sólo se marcan
// 'abandonada' cuando la misma persona escribe de nuevo, así que sin tráfico
// real «abiertas» es un cementerio y no una medida de actividad.
const { data: cfg } = await supabase
  .from("configuracion")
  .select("valor")
  .eq("clave", "conversacion_ventana_horas")
  .single();
const ventanaHoras = Number(cfg?.valor ?? 24);
const corte = Date.now() - ventanaHoras * 3600_000;
const abiertas = (convs ?? []).filter((c) => c.estado === "abierta");
const vivas = abiertas.filter((c) => new Date(c.ultima_actividad_en).getTime() > corte);
console.log(
  `\n  abiertas: ${abiertas.length}  ·  de esas, con actividad en las últimas ` +
    `${ventanaHoras} h: ${vivas.length}`,
);
if (abiertas.length > vivas.length) {
  console.log(
    `    ${abiertas.length - vivas.length} quedaron abiertas y nadie volvió: no son actividad`,
  );
}

/* --- Los mensajes, y dónde está la traza ------------------------------- */

titulo("MENSAJES");

const { data: msgs } = await supabase
  .from("mensajes")
  .select("direccion, intencion, confianza, origen_respuesta, modelo, tokens_entrada, tokens_salida, costo_usd, latencia_ms, creado_en, conversacion_id")
  .order("creado_en");

const entrantes = (msgs ?? []).filter((m) => m.direccion === "entrante");
const salientes = (msgs ?? []).filter((m) => m.direccion === "saliente");
console.log(`  entrantes ${entrantes.length}  ·  salientes ${salientes.length}`);

// La traza va en el SALIENTE, no en el entrante. Cualquier consulta que
// pregunte «de qué preguntaron» filtrando entrantes devuelve todo null.
const entrantesConTraza = entrantes.filter((m) => m.intencion !== null).length;
console.log(`  entrantes con intención cargada: ${entrantesConTraza} de ${entrantes.length}`);

const porOrigen = {};
for (const m of salientes) porOrigen[String(m.origen_respuesta)] = (porOrigen[String(m.origen_respuesta)] ?? 0) + 1;
console.log(`  salientes por origen: ${JSON.stringify(porOrigen)}`);

const porIntencion = {};
for (const m of salientes) if (m.intencion) porIntencion[m.intencion] = (porIntencion[m.intencion] ?? 0) + 1;
console.log(`  intenciones: ${JSON.stringify(porIntencion)}`);

// `costo_usd` es un PISO: viene del campo que devuelve OpenRouter y cuando no
// lo manda queda null. Promediar sobre todos los salientes divide por más
// mensajes de los que costaron algo.
const conCosto = salientes.filter((m) => m.costo_usd !== null);
const costoTotal = conCosto.reduce((n, m) => n + Number(m.costo_usd), 0);
console.log(
  `\n  costo: ${costoTotal.toFixed(6)} USD, de ${conCosto.length} de ${salientes.length} ` +
    `salientes que traen el dato`,
);
const porModelo = {};
for (const m of conCosto) {
  porModelo[m.modelo ?? "?"] = (porModelo[m.modelo ?? "?"] ?? 0) + Number(m.costo_usd);
}
for (const [mod, c] of Object.entries(porModelo)) {
  console.log(`    ${mod.padEnd(30)} ${c.toFixed(6)} USD`);
}

const latencias = salientes.filter((m) => m.latencia_ms > 0).map((m) => m.latencia_ms).sort((a, b) => a - b);
if (latencias.length > 0) {
  const p = (q) => latencias[Math.min(latencias.length - 1, Math.floor(latencias.length * q))];
  console.log(
    `\n  latencia (n=${latencias.length}): p50 ${p(0.5)} ms · p90 ${p(0.9)} ms · máx ${latencias.at(-1)} ms`,
  );
}

/* --- Tickets: el corte que importa no es el estado --------------------- */

titulo("TICKETS");

const { data: tks } = await supabase
  .from("tickets")
  .select("status, channel, conversation_id, created_at, resolved_at, sla_deadline");

const porCanal = {};
for (const t of tks ?? []) porCanal[String(t.channel)] = (porCanal[String(t.channel)] ?? 0) + 1;
console.log(`  total ${tks?.length}  ·  por canal: ${JSON.stringify(porCanal)}`);

// El corte entre «heredado» y «del bot nuevo» ya no existe: los 19 tickets que
// dejó ManyChat se borraron —decisión del área, el bot viejo no existe más— y
// con ellos se fue la razón de separarlos. Esta sección los contaba con
// `esEstadoHeredado()`, que además se renombró a `esEstadoConocido()` con el
// sentido INVERTIDO, así que el script venía muriendo acá con «is not a
// function» y nadie se enteró porque no se volvió a correr.
//
// En su lugar va lo que muestra la portada, calculado con la MISMA función que
// usa la portada. Así esto es una contraprueba contra producción: si el tablero
// dice otra cosa que este script, uno de los dos está mal.
const { medirCasos } = await import("../src/lib/metricas.ts");
const casos = medirCasos(tks ?? [], Date.now());

console.log(`
  lo que muestra la portada:`);
console.log(`    abiertos:  ${casos.abiertos}`);
console.log(`    vencidos:  ${casos.vencidos}`);
console.log(`    sin plazo: ${casos.sinPlazo}`);
console.log(`    cerrados:  ${casos.cerrados} (con fecha de cierre: ${casos.cerradosConFecha})`);
if (casos.cerrados > 0 && casos.cerradosConFecha === 0) {
  console.log("    *** No se puede calcular tiempo de resolución: ningún cerrado tiene fecha. ***");
}

/* --- Salud técnica: la cola y el corpus -------------------------------- */

titulo("SALUD TÉCNICA");

const { data: trabajos } = await supabase.from("trabajos").select("tipo, estado, intentos, error_detalle, creado_en");
const porEstadoT = {};
for (const t of trabajos ?? []) porEstadoT[t.estado] = (porEstadoT[t.estado] ?? 0) + 1;
console.log(`  cola: ${trabajos?.length} trabajos · ${JSON.stringify(porEstadoT)}`);
const conError = (trabajos ?? []).filter((t) => t.error_detalle !== null).length;
const reintentados = (trabajos ?? []).filter((t) => t.intentos > 1).length;
console.log(`  con error: ${conError} · reintentados: ${reintentados}`);

const { data: docs } = await supabase.from("documentos").select("id, titulo, cantidad_fragmentos, estado, activo");
const { count: nFrag } = await supabase.from("fragmentos").select("id", { count: "exact", head: true });
console.log(`\n  documentos: ${docs?.length} · fragmentos: ${nFrag}`);

// Cobertura del corpus: qué documentos citó Migue alguna vez. Es la métrica que
// dice si sirvió cargar un PDF de 45 páginas.
// `fragmentos_citados` no está en el select de más arriba: se pide aparte.
const citados = new Set();
const { data: conCitas } = await supabase
  .from("mensajes")
  .select("fragmentos_citados")
  .not("fragmentos_citados", "is", null);
const idsCitados = new Set((conCitas ?? []).flatMap((m) => m.fragmentos_citados ?? []));
if (idsCitados.size > 0) {
  const { data: frags } = await supabase
    .from("fragmentos")
    .select("documento_id")
    .in("id", [...idsCitados]);
  for (const f of frags ?? []) citados.add(f.documento_id);
}
console.log(`  fragmentos citados alguna vez: ${idsCitados.size} de ${nFrag}`);
console.log(`  documentos citados alguna vez: ${citados.size} de ${docs?.length}`);
for (const d of docs ?? []) {
  console.log(`    ${citados.has(d.id) ? "citado " : "NUNCA  "} ${d.titulo}`);
}

/* --- Conocimiento y basura de pruebas ---------------------------------- */

titulo("CONOCIMIENTO Y RUIDO");

for (const t of ["faqs", "respuestas_fijas", "sin_respuesta", "valoraciones"]) {
  const { count } = await supabase.from(t).select("id", { count: "exact", head: true });
  console.log(`  ${t.padEnd(20)} ${count}`);
}

// La suite de integración escribe en producción con este marcador y lo borra en
// un `finally`. Una corrida interrumpida deja basura que las métricas contarían
// como actividad.
const { count: basura } = await supabase
  .from("conversaciones")
  .select("id", { count: "exact", head: true })
  .eq("canal_usuario_id", "__prueba_escritura__");
console.log(`\n  filas de la suite de integración sin limpiar: ${basura}`);
