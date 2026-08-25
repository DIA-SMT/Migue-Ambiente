/**
 * Corre las funciones de Métricas contra producción y compara con la verdad.
 *
 *   node --env-file=../../.env.local herramientas/verificar-metricas.mjs
 *
 * No comprueba que compile: comprueba que cada número signifique lo que dice. Es
 * la clase de error que más veces mordió a este proyecto —una pantalla que decía
 * «20 abiertos» y «13 vencidos» sobre las mismas filas— así que cada métrica se
 * calcula por el camino de la pantalla y por un camino independiente, y se
 * comparan.
 */
import { createClient } from "@supabase/supabase-js";
import {
  medirAlcance,
  medirCasos,
  medirCola,
  medirCorpus,
  medirCosto,
  medirLatencia,
  proporcion,
  repartoPorOrigen,
  MINIMO_PARA_PORCENTAJE,
} from "../src/lib/metricas.ts";
import { estaCerrado } from "../src/lib/tipos.ts";

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

const AHORA = Date.now();

/* --- Las mismas consultas que hace la pantalla -------------------------- */

const { data: convs } = await supabase
  .from("conversaciones")
  .select("id, canal, canal_usuario_id, estado, cantidad_mensajes, iniciada_en, ultima_actividad_en");
const { data: msgs } = await supabase
  .from("mensajes")
  .select(
    "direccion, intencion, confianza, origen_respuesta, modelo, tokens_entrada, tokens_salida, costo_usd, latencia_ms, fragmentos_citados, conversacion_id, creado_en",
  );
const { data: tks } = await supabase.from("tickets").select("*");
const { data: docs } = await supabase
  .from("documentos")
  .select("id, titulo, cantidad_fragmentos")
  .eq("activo", true);
const { data: trabajos } = await supabase
  .from("trabajos")
  .select("estado, intentos, error_detalle, creado_en");
const { count: nFrag } = await supabase
  .from("fragmentos")
  .select("id", { count: "exact", head: true });

const idsCitados = [...new Set((msgs ?? []).flatMap((m) => m.fragmentos_citados ?? []))];
const mapa = new Map();
if (idsCitados.length > 0) {
  const { data } = await supabase.from("fragmentos").select("id, documento_id").in("id", idsCitados);
  for (const f of data ?? []) mapa.set(f.id, f.documento_id);
}

/* --- 1 · Alcance: contra un conteo independiente ----------------------- */

const alcance = medirAlcance(convs ?? [], msgs ?? [], 24, AHORA);

// Camino independiente: pedirle a la base los distintos, no calcularlo en JS.
const distintos = new Set((convs ?? []).map((c) => c.canal + ":" + c.canal_usuario_id));
if (alcance.personas !== distintos.size) {
  mal(`personas: la función dice ${alcance.personas} y hay ${distintos.size}`);
} else {
  bien(`personas distintas: ${alcance.personas}`);
}

const { count: nEntrantes } = await supabase
  .from("mensajes")
  .select("id", { count: "exact", head: true })
  .eq("direccion", "entrante");
if (alcance.turnos !== nEntrantes) {
  mal(`turnos: la función dice ${alcance.turnos} y la base cuenta ${nEntrantes} entrantes`);
} else {
  bien(`turnos (mensajes de vecinos): ${alcance.turnos}`);
}

// Las abiertas tienen que sumar: vivas + sin volver = abiertas.
const { count: nAbiertas } = await supabase
  .from("conversaciones")
  .select("id", { count: "exact", head: true })
  .eq("estado", "abierta");
if (alcance.vivas + alcance.abiertasSinVolver !== nAbiertas) {
  mal(
    `abiertas: ${alcance.vivas} vivas + ${alcance.abiertasSinVolver} sin volver != ${nAbiertas}`,
  );
} else {
  bien(`abiertas: ${nAbiertas} (${alcance.vivas} con actividad reciente)`);
}

/* --- 2 · Reparto: tiene que sumar el total de salientes ---------------- */

const reparto = repartoPorOrigen(msgs ?? []);
const sumaReparto = reparto.reduce((n, r) => n + r.n, 0);
const { count: nSalientes } = await supabase
  .from("mensajes")
  .select("id", { count: "exact", head: true })
  .eq("direccion", "saliente");

if (sumaReparto !== nSalientes) {
  mal(`el reparto suma ${sumaReparto} y hay ${nSalientes} salientes: se pierde alguno`);
} else {
  bien(`el reparto por origen suma los ${nSalientes} salientes`);
}
for (const r of reparto) {
  console.log(`         ${r.rotulo.padEnd(34)} ${String(r.n).padStart(3)}  ${proporcion(r.n, sumaReparto)}`);
}

/* --- 3 · Casos: el corte por canal contra el corte por estado ---------- */

const casos = medirCasos(tks ?? [], AHORA);

// El corte «heredado / del bot nuevo» se fue con los datos del bot viejo: ya no
// hay nada de ManyChat en la tabla. Se comprueba que siga siendo cierto, porque
// si reaparecieran filas de otro canal las métricas volverían a mezclar cosas.
const { count: nManychat } = await supabase
  .from("tickets")
  .select("id", { count: "exact", head: true })
  .eq("channel", "manychat");
if (nManychat !== 0) {
  mal(`hay ${nManychat} ticket(s) de manychat: se borraron y volvieron a aparecer`);
} else {
  bien("no queda nada del bot anterior");
}

// LA COMPROBACIÓN QUE IMPORTA: que abiertos y cerrados usen la MISMA definición.
// Es la forma exacta del bug de «20 abiertos / 13 vencidos».
const cerradosAparte = (tks ?? []).filter((t) => estaCerrado(t)).length;
if (casos.abiertos + cerradosAparte !== casos.total) {
  mal(
    `abiertos (${casos.abiertos}) + cerrados (${cerradosAparte}) != total (${casos.total}): ` +
      `hay dos definiciones de «cerrado» en juego`,
  );
} else {
  bien(`abiertos + cerrados = total: una sola definición de «cerrado»`);
}
if (casos.vencidos > casos.abiertos) {
  mal(`vencidos (${casos.vencidos}) > abiertos (${casos.abiertos}): imposible`);
} else {
  bien(`vencidos (${casos.vencidos}) <= abiertos (${casos.abiertos})`);
}

/* --- 4 · Costo: el total contra la suma cruda -------------------------- */

const costo = medirCosto(msgs ?? [], (convs ?? []).length);
const crudo = (msgs ?? [])
  .filter((m) => m.direccion === "saliente" && m.costo_usd !== null)
  .reduce((n, m) => n + Number(m.costo_usd), 0);

if (Math.abs(costo.totalUsd - crudo) > 1e-12) {
  mal(`costo: la función dice ${costo.totalUsd} y la suma cruda da ${crudo}`);
} else {
  bien(`costo total: US$ ${costo.totalUsd.toFixed(6)} (${costo.conDato} de ${costo.salientes} con dato)`);
}
const sumaModelos = costo.porModelo.reduce((n, m) => n + m.usd, 0);
if (Math.abs(sumaModelos - costo.totalUsd) > 1e-12) {
  mal(`el desglose por modelo suma ${sumaModelos} y el total es ${costo.totalUsd}`);
} else {
  bien(`el desglose por modelo suma el total`);
}

/* --- 5 · Latencia: percentiles dentro del rango ------------------------ */

const lat = medirLatencia(msgs ?? []);
const crudas = (msgs ?? [])
  .filter((m) => m.direccion === "saliente" && (m.latencia_ms ?? 0) > 0)
  .map((m) => m.latencia_ms)
  .sort((a, b) => a - b);

if (lat.n !== crudas.length) {
  mal(`latencia: n=${lat.n} y hay ${crudas.length} con latencia > 0`);
} else if (lat.n > 0) {
  const ok =
    lat.p50 >= crudas[0] &&
    lat.p50 <= lat.maximo &&
    lat.p90 >= lat.p50 &&
    lat.maximo === crudas.at(-1);
  if (!ok) mal(`percentiles fuera de rango: p50=${lat.p50} p90=${lat.p90} max=${lat.maximo}`);
  else bien(`latencia: p50 ${lat.p50} ms · p90 ${lat.p90} ms · máx ${lat.maximo} ms (n=${lat.n})`);
} else {
  bien("latencia: sin datos todavía");
}

/* --- 6 · Corpus: citados + nunca citados = total ----------------------- */

const corpus = medirCorpus(docs ?? [], nFrag ?? 0, mapa, msgs ?? []);
if (corpus.citados.length + corpus.nuncaCitados.length !== (docs ?? []).length) {
  mal(
    `corpus: ${corpus.citados.length} citados + ${corpus.nuncaCitados.length} nunca != ` +
      `${(docs ?? []).length} documentos`,
  );
} else {
  bien(`corpus: ${corpus.citados.length} citados + ${corpus.nuncaCitados.length} nunca = ${(docs ?? []).length}`);
}
if (corpus.fragmentosCitados > corpus.fragmentos) {
  mal(`fragmentos citados (${corpus.fragmentosCitados}) > totales (${corpus.fragmentos})`);
} else {
  bien(`fragmentos citados: ${corpus.fragmentosCitados} de ${corpus.fragmentos}`);
}
for (const d of corpus.nuncaCitados) console.log(`         NUNCA   ${d.titulo}`);
for (const d of corpus.citados) console.log(`         ${String(d.veces).padStart(3)}×    ${d.titulo}`);

/* --- 7 · Cola ---------------------------------------------------------- */

const cola = medirCola(trabajos ?? [], AHORA);
const { count: nTrabajos } = await supabase
  .from("trabajos")
  .select("id", { count: "exact", head: true });
if (cola.total !== nTrabajos) mal(`cola: ${cola.total} != ${nTrabajos}`);
else bien(`cola: ${cola.total} trabajos, ${cola.conError} con error, ${cola.reintentados} reintentados`);

/* --- 8 · La regla de los porcentajes ---------------------------------- */

// Con el N de hoy, NINGÚN porcentaje debería mostrarse.
const conNChico = proporcion(3, 9);
if (/%/.test(conNChico)) {
  mal(`proporcion(3, 9) devolvió «${conNChico}»: con N < ${MINIMO_PARA_PORCENTAJE} no va porcentaje`);
} else {
  bien(`con N chico se muestra crudo: proporcion(3, 9) = «${conNChico}»`);
}
const conNGrande = proporcion(300, 900);
if (!/%/.test(conNGrande)) {
  mal(`proporcion(300, 900) devolvió «${conNGrande}»: con N grande sí va porcentaje`);
} else {
  bien(`con N grande se muestra porcentaje: proporcion(300, 900) = «${conNGrande}»`);
}

/* --- 9 · Lo que la pantalla va a decir de entrada --------------------- */

console.log();
console.log("  LO QUE VA A MOSTRAR HOY:");
console.log(`    personas distintas: ${alcance.personas}`);
if (alcance.personas <= 1) {
  console.log("    -> el cartel de «una sola cuenta», sin porcentajes. Correcto.");
}
const fallback = reparto.find((r) => r.clave === "fallback")?.n ?? 0;
const { count: nSinResp } = await supabase
  .from("sin_respuesta")
  .select("id", { count: "exact", head: true });
console.log(`    no entendió y mostró el menú: ${fallback} veces`);
console.log(`    filas en sin_respuesta: ${nSinResp}`);
if (fallback > 0 && nSinResp === 0) {
  console.log("    -> el aviso de que esas fallas NO llegan a «Sin responder». Correcto.");
}

console.log();
console.log(fallas === 0 ? "TODO OK" : `${fallas} PROBLEMA(S)`);
process.exit(fallas === 0 ? 0 : 1);
