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


// --- 6 · Las consultas de la sección Respuestas ---
console.log();
for (const tabla of ["faqs", "respuestas_fijas"]) {
  const { data, error } = await supabase
    .from(tabla)
    .select("*")
    .order("activa", { ascending: true })
    .order("veces_usada", { ascending: false });
  if (error) mal(`${tabla}: ${error.message}`);
  else console.log(`${tabla.toUpperCase()} — ${data.length} filas (${data.filter((f) => f.activa).length} publicadas)`);
}

const { count: entrantes, error: eMsj } = await supabase
  .from("mensajes")
  .select("id", { count: "exact", head: true })
  .eq("direccion", "entrante");
if (eMsj) mal(`conteo de mensajes entrantes: ${eMsj.message}`);
else console.log(`MENSAJES entrantes con los que comparar un disparador: ${entrantes}`);

// `probar_disparadores` con service_role da «no autorizado» porque pide padrón:
// es lo correcto, pero significa que acá sólo se puede verificar que EXISTE.
const { error: ePd } = await supabase.rpc("probar_disparadores", {
  p_disparadores: ["neumatico"], p_modo: "contiene", p_texto: "neumatico",
});
if (ePd && ePd.code !== "42501") mal(`probar_disparadores: ${ePd.message}`);
else console.log("probar_disparadores: existe y exige padrón (no se puede probar más desde acá)");

const { error: ePc } = await supabase.rpc("probar_conocimiento", { p_consulta: "contenedores" });
if (ePc && ePc.code !== "42501") mal(`probar_conocimiento: ${ePc.message}`);
else console.log("probar_conocimiento: existe y exige padrón");


// --- 7 · La sección Textos del bot ---
console.log();
const { data: textos, error: eTxt } = await supabase
  .from("textos_bot")
  .select("clave, texto, descripcion, actualizado_en")
  .order("clave");
if (eTxt) mal(`textos_bot: ${eTxt.message}`);
else {
  console.log(`TEXTOS_BOT — ${textos.length} mensajes`);
  const vacios = textos.filter((t) => !t.texto || t.texto.trim() === "");
  if (vacios.length) console.log(`  vacios: ${vacios.map((t) => t.clave).join(", ")}`);
}

const { data: cfg } = await supabase
  .from("configuracion")
  .select("clave, valor")
  .in("clave", ["sla_horas_habiles", "empresa_recoleccion"]);
const porClave = new Map((cfg ?? []).map((c) => [c.clave, c.valor]));

// Que todo marcador escrito en un texto sea uno que ESA CLAVE va a resolver. Un
// {palzo} mal escrito se le envia LITERAL al vecino, con las llaves.
//
// La validacion se hace con `marcadoresQueNoSeResuelven()` del dominio, que es
// la misma funcion que usa el panel antes de guardar. Este script antes leia
// `configuracion.marcadores_disponibles` y comparaba contra esa lista global, y
// eso estaba mal de dos formas a la vez:
//
//   - Daba FALSOS POSITIVOS. Gritaba «derivar_a_migue usa marcadores que el bot
//     no resuelve: {migue}», y el bot si lo resuelve: el orquestador llama a
//     `interpolar(..., { migue: enlace })` en la rama de derivacion. La lista
//     global no lo incluia porque solo tenia los cuatro de confirmacion.
//   - Y habria dado FALSOS NEGATIVOS, que es peor: un {plazo} escrito en
//     `bienvenida` pasaba el chequeo, porque el nombre estaba en la lista,
//     aunque `bienvenida` nunca pasa por `interpolar`. Ese es exactamente el bug
//     que hizo nacer `marcadores.ts`.
//
// `marcadores_disponibles` ya no lo lee nadie. Sigue en la tabla y el panel la
// muestra en Reglas marcada como huerfana, con la explicacion.
const { marcadoresQueNoSeResuelven, marcadoresDe } = await import(
  "@migue/dominio/compartido"
);

let textosConMarcadores = 0;
for (const t of textos ?? []) {
  const malos = marcadoresQueNoSeResuelven(t.clave, String(t.texto));
  if (malos.length) {
    const admite = marcadoresDe(t.clave);
    mal(
      `${t.clave} usa ${malos.join(", ")} y no los resuelve. ` +
        (admite.length ? `Solo admite ${admite.join(", ")}` : "No admite ninguno"),
    );
  } else if (marcadoresDe(t.clave).length > 0) {
    textosConMarcadores++;
  }
}
console.log(
  `MARCADORES: ${textosConMarcadores} texto(s) con marcadores, todos validos para su clave`,
);


// --- 8 · La bandeja de pedidos y reclamos ---
console.log();
const { data: tks, error: eTk } = await supabase
  .from("tickets")
  .select("*")
  .order("created_at", { ascending: false })
  .limit(200);

if (eTk) mal(`tickets: ${eTk.message}`);
else {
  // Ojo con el nombre: antes acá se importaba `esEstadoHeredado`, que ya no
  // existe. Lo renombré a `esEstadoConocido` —con el sentido INVERTIDO— cuando
  // se borraron los tickets del bot anterior, y este script quedó llamando a una
  // función inexistente. Reventaba con «esEstadoHeredado is not a function» y no
  // me di cuenta porque no lo volví a correr hasta hoy.
  const { situacionSla, datosFaltantes, esEstadoConocido, estaCerrado } = await import("../src/lib/tipos.ts");
  const ahora = Date.now();

  const porUrgencia = [...tks].sort(
    (a, b) => situacionSla(a, ahora).urgencia - situacionSla(b, ahora).urgencia,
  );

  console.log(`TICKETS — ${tks.length}`);
  console.log("  plazo                estado                        falta");
  console.log("  " + "-".repeat(76));
  for (const t of porUrgencia.slice(0, 8)) {
    const s = situacionSla(t, ahora);
    const f = datosFaltantes(t);
    console.log(
      "  " +
        `[${s.tono}] ${s.etiqueta}`.padEnd(21) +
        (t.status + (esEstadoConocido(t.status) ? "" : " (DESCONOCIDO)")).padEnd(30) +
        (f.length ? f.join(", ") : "—"),
    );
  }

  const abiertos = tks.filter((t) => !estaCerrado(t)).length;
  const vencidos = tks.filter((t) => !estaCerrado(t) && situacionSla(t, ahora).urgencia === 0).length;
  const sinPlazo = tks.filter((t) => t.sla_deadline === null).length;
  console.log();
  console.log(`  abiertos: ${abiertos}  ·  vencidos: ${vencidos}  ·  sin plazo cargado: ${sinPlazo}`);

  // Todo estado que hay en la base, para confirmar que el panel los muestra
  // aunque no los ofrezca.
  const estados = [...new Set(tks.map((t) => t.status))];
  console.log(`  estados presentes: ${estados.join(" | ")}`);
  // Un estado que el panel no conoce ya no es «heredado»: los tickets del bot
  // anterior se borraron. Hoy significa que algo escribió un estado que el panel
  // no sabe mostrar, y eso es un error, no data vieja.
  const desconocidos = estados.filter((e) => !esEstadoConocido(e));
  if (desconocidos.length) mal(`estados que el panel no conoce: ${desconocidos.join(" | ")}`);
}

const { data: prg, error: ePr } = await supabase
  .from("program_requests")
  .select("*")
  .order("created_at", { ascending: false })
  .limit(200);
if (ePr) mal(`program_requests: ${ePr.message}`);
else {
  console.log();
  console.log(`PROGRAMAS — ${prg.length}`);
  for (const p of prg) {
    console.log(`  ${p.program_type.padEnd(12)} ${String(p.status).padEnd(12)} ${p.institution_name ?? "—"}`);
  }
  // Las columnas que la ficha lee tienen que existir.
  for (const col of ["institution_name", "responsible_person", "contact_phone", "student_count", "photo_ref", "channel"]) {
    if (prg.length && prg[0][col] === undefined) mal(`program_requests no tiene la columna ${col}`);
  }
}

console.log();
if (fallas > 0) { console.log(`${fallas} problema(s)`); process.exitCode = 1; }
else console.log("todas las consultas del panel devuelven lo que las pantallas esperan");
