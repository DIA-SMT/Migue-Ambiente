/**
 * Verifica en producción lo que la 037 le agrega al panel.
 *
 *   node --env-file=../../.env.local herramientas/verificar-alertas.mjs
 *
 * Corre con `service_role`, y eso define qué se puede comprobar desde acá:
 *
 *   SÍ   que `alertas_asesor` exista con las columnas que lee el panel
 *   SÍ   que `tickets` tenga las tres columnas del veredicto de foto
 *   SÍ   que `atender_alerta` esté expuesta por PostgREST y RECHACE a
 *        service_role con «no autorizado» — es el guardia funcionando
 *   SÍ   que las semillas de la 037 estén (modelo_vision y los 5 textos)
 *   NO   atender de punta a punta: eso lo cubre el bloque Q del arnés,
 *        que corre con roles reales contra un Postgres desechable
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

/* --- 1 · La tabla y su contrato de columnas ------------------------------- */

const COLUMNAS_ALERTA = [
  "id", "conversacion_id", "canal", "nombre_usuario", "telefono", "motivo",
  "estado", "atendida_por", "atendida_en", "notas", "creado_en", "actualizado_en",
];

// Se piden las columnas POR NOMBRE: un select("*") sobre una tabla vacía no
// dice qué columnas faltan; pedir una inexistente devuelve 42703.
const { error: eTabla } = await supabase
  .from("alertas_asesor")
  .select(COLUMNAS_ALERTA.join(", "))
  .limit(1);
if (eTabla) mal(`alertas_asesor: ${eTabla.message}`);
else bien(`alertas_asesor con sus ${COLUMNAS_ALERTA.length} columnas`);

/* --- 2 · El veredicto de foto en tickets ---------------------------------- */

const { error: eTicket } = await supabase
  .from("tickets")
  .select("photo_verdict, photo_category, photo_detail")
  .limit(1);
if (eTicket) mal(`tickets sin las columnas de veredicto: ${eTicket.message}`);
else bien("tickets con photo_verdict, photo_category y photo_detail");

/* --- 3 · La función que cierra alertas ------------------------------------ */

const { error: eRpc } = await supabase.rpc("atender_alerta", {
  p_alerta_id: "00000000-0000-0000-0000-000000000000",
  p_estado: "atendida",
  p_notas: null,
});
if (!eRpc) {
  mal("atender_alerta aceptó a service_role: el guardia del padrón no está");
} else if (/no autorizado/i.test(eRpc.message)) {
  bien("atender_alerta expuesta, y rechaza a quien no está en el padrón");
} else if (/function .* does not exist|Could not find/i.test(eRpc.message)) {
  mal(`atender_alerta no existe: ${eRpc.message}`);
} else {
  mal(`atender_alerta contestó raro: ${eRpc.message}`);
}

/* --- 4 · Las semillas ------------------------------------------------------ */

const { data: cfg } = await supabase
  .from("configuracion")
  .select("clave")
  .eq("clave", "modelo_vision");
if ((cfg ?? []).length === 1) bien("configuracion.modelo_vision presente");
else mal("falta la config modelo_vision");

const CLAVES = [
  "asesor_pedir_telefono", "asesor_reintento_telefono", "asesor_confirmacion",
  "asesor_sin_telefono", "retiro_foto_no_corresponde",
];
const { data: textos } = await supabase
  .from("textos_bot")
  .select("clave")
  .in("clave", CLAVES);
const presentes = new Set((textos ?? []).map((t) => t.clave));
const faltan = CLAVES.filter((c) => !presentes.has(c));
if (faltan.length === 0) bien("los 5 textos del flujo de asesor y la repregunta de foto");
else mal(`faltan textos: ${faltan.join(", ")}`);

/* --- 5 · El padrón, sin el cual nada de esto se ve ------------------------- */

const { count: padron } = await supabase
  .from("personal_panel")
  .select("usuario_id", { count: "exact", head: true })
  .eq("activo", true);
if ((padron ?? 0) > 0) bien(`padrón con ${padron} persona(s) activa(s)`);
else mal("el padrón está vacío: nadie puede ver las alertas");

console.log(fallas === 0 ? "\nTodo en orden." : `\n${fallas} problema(s).`);
process.exit(fallas === 0 ? 0 : 1);
