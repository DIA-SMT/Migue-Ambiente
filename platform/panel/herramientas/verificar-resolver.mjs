/**
 * Verifica en producción lo que la 021 le agrega al panel.
 *
 *   node --env-file=../../.env.local herramientas/verificar-resolver.mjs
 *
 * Corre con `service_role`, y eso define qué se puede comprobar desde acá y qué
 * no:
 *
 *   SÍ   que `v_sin_respuesta` exista y traiga las 14 columnas que lee el panel
 *   SÍ   que las tres RPC estén expuestas por PostgREST
 *   SÍ   que el padrón esté poblado, sin lo cual nada de esto es accesible
 *   NO   el comportamiento de resolver de punta a punta
 *
 * Lo último no es una omisión. Las tres funciones verifican el padrón adentro
 * (son SECURITY DEFINER, RLS no se les aplica), y `service_role` no tiene
 * `auth.uid()`, así que no está en el padrón y recibe «no autorizado». Es el
 * comportamiento correcto: hacer que `service_role` pase sería abrir la puerta
 * que la verificación existe para cerrar.
 *
 * Que resolver funcione de verdad lo cubre el bloque M del arnés
 * (`db/pruebas/010_pruebas_funcionales.sql`), que corre contra un Postgres real
 * con los stubs de `auth`, y cuyos dos sabotajes están comprobados.
 */
import { createClient } from "@supabase/supabase-js";

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

/* --- 1 · La vista y su contrato de columnas ------------------------------- */

const COLUMNAS = [
  "id", "pregunta", "motivo", "confianza", "veces_repetida", "estado", "notas",
  "creado_en", "actualizado_en", "resuelta_con_faq_id", "resuelta_con_fija_id",
  "respuesta_titulo", "respuesta_publicada", "respuesta_tipo",
];

const { data: vista, error: eVista } = await supabase
  .from("v_sin_respuesta")
  .select("*")
  .order("veces_repetida", { ascending: false })
  .limit(300);

if (eVista) {
  mal(`v_sin_respuesta: ${eVista.message}`);
} else {
  bien(`v_sin_respuesta responde — ${vista.length} fila(s)`);
  // Con la tabla vacía, `select *` no revela nada. Se pide columna por columna:
  // un nombre inexistente da 42703, así que el contrato se comprueba sin datos.
  let faltantes = 0;
  for (const col of COLUMNAS) {
    const { error } = await supabase.from("v_sin_respuesta").select(col).limit(1);
    if (error) {
      mal(`falta la columna ${col}: ${error.message}`);
      faltantes++;
    }
  }
  if (faltantes === 0) bien(`las ${COLUMNAS.length} columnas que lee el panel existen`);
}

/* --- 2 · Las RPC expuestas, y el padrón cerrado --------------------------- */

// Se las llama con un id inexistente y se espera «no autorizado»: el mensaje
// viene de ADENTRO de la función, así que prueba dos cosas de una — que
// PostgREST la expone (un 404 diría lo contrario) y que la verificación de
// padrón está puesta y actúa antes de tocar cualquier fila.
const FALSO = "00000000-0000-0000-0000-000000000000";

const LLAMADAS = [
  ["resolver_con_faq", { p_sin_respuesta_id: FALSO, p_pregunta: "x", p_respuesta: "y", p_etiquetas: [], p_publicar: false }],
  ["resolver_con_fija", { p_sin_respuesta_id: FALSO, p_nombre: "x", p_disparadores: ["y"], p_modo: "contiene", p_respuesta: "z", p_publicar: false, p_notas: null }],
  ["descartar_sin_respuesta", { p_sin_respuesta_id: FALSO, p_motivo: "x" }],
];

for (const [nombre, args] of LLAMADAS) {
  const { error } = await supabase.rpc(nombre, args);
  if (!error) {
    // Lo peor posible: `service_role` resolvió algo. Querría decir que la
    // verificación de padrón no está, y cualquiera con la clave del bot podría
    // escribir respuestas que los vecinos reciben.
    mal(`${nombre} atendió a service_role: le falta la verificación de padrón`);
  } else if (/could not find|schema cache|does not exist/i.test(error.message)) {
    mal(`${nombre} no está expuesta como RPC: ${error.message}`);
  } else if (/no autorizado/i.test(error.message)) {
    bien(`${nombre} expuesta, y rechaza a quien no está en el padrón`);
  } else {
    mal(`${nombre} falló con algo inesperado: ${error.message}`);
  }
}

/* --- 3 · El padrón poblado ------------------------------------------------ */

// Si `personal_panel` estuviera vacío, TODO lo anterior seguiría dando ok y el
// panel entero sería inaccesible: cada política de la 017 pasa por acá. Es la
// forma en que esta pantalla podría estar perfecta y no servirle a nadie.
const { data: padron, error: ePad } = await supabase
  .from("personal_panel")
  .select("nombre, rol, activo");

if (ePad) {
  mal(`personal_panel: ${ePad.message}`);
} else if (padron.length === 0) {
  mal("el padrón está VACÍO: nadie puede entrar al panel ni resolver nada");
} else {
  const activos = padron.filter((p) => p.activo);
  const puedenPublicar = activos.filter((p) => p.rol === "admin" || p.rol === "supervisor");
  if (activos.length === 0) {
    mal(`hay ${padron.length} persona(s) en el padrón pero ninguna activa`);
  } else {
    bien(
      `padrón: ${activos.length} activa(s) — ${activos.map((p) => `${p.nombre} (${p.rol})`).join(", ")}`,
    );
  }
  if (puedenPublicar.length === 0) {
    // No es un error de esquema, pero sí un cuello de botella real: se pueden
    // escribir borradores y ninguno llegaría nunca a un vecino.
    mal("nadie con rol admin o supervisor: se podrían escribir borradores y nunca publicarlos");
  }
}

/* --- 4 · Qué va a ver el usuario ----------------------------------------- */

const { count: total } = await supabase
  .from("sin_respuesta")
  .select("id", { count: "exact", head: true });
const { count: pend } = await supabase
  .from("sin_respuesta")
  .select("id", { count: "exact", head: true })
  .eq("estado", "pendiente");

console.log();
console.log(`  sin_respuesta: ${total} fila(s), ${pend} pendiente(s)`);
if (total === 0) {
  console.log("  (la pestaña «Sin responder» va a abrir vacía hasta que el bot falle una consulta)");
}

console.log();
console.log(fallas === 0 ? "TODO OK" : `${fallas} PROBLEMA(S)`);
process.exit(fallas === 0 ? 0 : 1);
