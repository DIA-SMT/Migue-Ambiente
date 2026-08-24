/**
 * Verifica que las consultas del panel devuelvan lo que las pantallas esperan.
 *
 * Corre con la service_role, así que NO prueba el RLS —eso lo cubre el arnés de
 * la base—. Lo que prueba es el contrato: que las columnas existan, que los
 * filtros sobre `payload->>documento_id` funcionen, y que los datos tengan la
 * forma que el componente asume. Es lo verificable sin poder iniciar sesión.
 *
 *   node --env-file=../../.env.local herramientas/verificar-consultas.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { estadoVisible, tamanoLegible } from "../src/lib/tipos.ts";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let fallas = 0;
const mal = (m) => { console.log("  FALLA:", m); fallas++; };

// --- 1 · La consulta del listado, idéntica a la de page.tsx ---
const { data: documentos, error } = await supabase
  .from("documentos")
  .select("*")
  .order("activo", { ascending: false })
  .order("titulo", { ascending: true });

if (error) mal(`el listado falló: ${error.message}`);
else {
  console.log(`LISTADO — ${documentos.length} documentos\n`);
  console.log("  estado                 activo  frags  tamaño     título");
  console.log("  " + "-".repeat(74));
  for (const d of documentos) {
    const e = estadoVisible(d);
    console.log(
      "  " + `[${e.tono}] ${e.etiqueta}`.padEnd(23) +
      (d.activo ? "sí" : "no").padEnd(8) +
      String(d.cantidad_fragmentos).padStart(5) +
      tamanoLegible(d.bytes).padStart(10) + "  " +
      d.titulo.slice(0, 40),
    );
    for (const col of ["titulo","nombre_archivo","formato","ruta_storage","bytes","estado","cantidad_fragmentos","activo","actualizado_en"]) {
      if (d[col] === undefined) mal(`a ${d.titulo}: le falta la columna ${col}`);
    }
  }
}

// --- 2 · Fragmentos de un documento ---
const conFrags = (documentos ?? []).find((d) => d.cantidad_fragmentos > 0);
if (conFrags) {
  const { data: frags, error: e2 } = await supabase
    .from("fragmentos")
    .select("id, orden, texto, pagina, titulo_seccion, tokens_aprox")
    .eq("documento_id", conFrags.id)
    .order("orden");
  if (e2) mal(`fragmentos: ${e2.message}`);
  else {
    console.log(`\nFRAGMENTOS de «${conFrags.titulo.slice(0, 40)}» — ${frags.length}`);
    if (frags.length !== conFrags.cantidad_fragmentos) {
      mal(`cantidad_fragmentos dice ${conFrags.cantidad_fragmentos} y hay ${frags.length}`);
    }
    const ordenes = frags.map((f) => f.orden);
    if (ordenes.some((o, i) => o !== i + 1)) mal("el orden no es contiguo desde 1");
    console.log(`  sin título de sección: ${frags.filter((f) => !f.titulo_seccion).length}`);
    console.log(`  primero: [${frags[0].orden}] p${frags[0].pagina} «${frags[0].titulo_seccion}»`);
  }
}

// --- 3 · Historial de trabajos: el filtro sobre payload es el riesgoso ---
if (conFrags) {
  const { data: trabajos, error: e3 } = await supabase
    .from("trabajos")
    .select("id, tipo, estado, intentos, max_intentos, error_detalle, creado_en, finalizado_en, tomado_por")
    .eq("payload->>documento_id", conFrags.id)
    .order("creado_en", { ascending: false })
    .limit(10);
  if (e3) mal(`historial: ${e3.message}`);
  else {
    console.log(`\nHISTORIAL de ese documento — ${trabajos.length} trabajos`);
    for (const t of trabajos.slice(0, 3)) {
      console.log(`  ${t.tipo.padEnd(22)} ${t.estado.padEnd(10)} ${t.intentos}/${t.max_intentos}`);
    }
    if (trabajos.length === 0) mal("el filtro sobre payload->>documento_id no devolvió nada");
  }
}

// --- 4 · La verificación de «ya hay un trabajo en curso» de reintentar() ---
if (conFrags) {
  const { error: e4 } = await supabase
    .from("trabajos")
    .select("id")
    .in("estado", ["pendiente", "tomado"])
    .in("tipo", ["ingestar_documento", "reindexar_documento"])
    .eq("payload->>documento_id", conFrags.id)
    .limit(1);
  if (e4) mal(`la consulta de reintentar(): ${e4.message}`);
  else console.log("\nCONSULTA de reintentar(): sintaxis aceptada");
}

// --- 5 · URL firmada del bucket privado ---
if (documentos?.length) {
  const { data, error: e5 } = await supabase.storage
    .from(process.env.NEXT_PUBLIC_SUPABASE_BUCKET_DOCUMENTOS ?? "documentos")
    .createSignedUrl(documentos[0].ruta_storage, 60);
  if (e5) mal(`URL firmada: ${e5.message}`);
  else console.log(`URL FIRMADA: se generó (${data.signedUrl.slice(0, 58)}…)`);
}

console.log();
if (fallas > 0) { console.log(`${fallas} problema(s)`); process.exitCode = 1; }
else console.log("todas las consultas del panel devuelven lo que las pantallas esperan");
