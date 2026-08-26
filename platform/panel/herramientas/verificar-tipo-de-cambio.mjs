/**
 * Verifica la 030 en producción: la clave del tipo de cambio.
 *
 *   node --env-file=../../.env.local --env-file=.env.local  *        herramientas/verificar-tipo-de-cambio.mjs
 *
 * Los dos archivos: la clave de servicio vive en el de la raíz y la ANON en el
 * del panel, porque es la que se le manda al navegador.
 *
 * Siembra la fila si no está. Las migraciones de este proyecto se aplican
 * pegando `aplicar_todo.sql` en el editor de Supabase, y para UNA fila de
 * configuración eso es un trámite que se posterga — y mientras tanto el tablero
 * no puede convertir a pesos. La inserción es idempotente y el script dice cuál
 * de las dos cosas hizo.
 *
 * Lo que comprueba:
 *
 *   SÍ   que la fila exista, con categoría 'panel' y descripción cargada
 *   SÍ   que el valor sea un número (el tablero hace `Number()` sobre el jsonb)
 *   SÍ   que la clave ANON no pueda leerla — es configuración interna, y el RLS
 *        de `configuracion` exige estar en el padrón del panel
 *   NO   que el valor sea el tipo de cambio real de hoy. Eso no lo puede saber
 *        ningún script: es justamente por eso que la fila la carga una persona.
 */
import { createClient } from "@supabase/supabase-js";

const CLAVE = "tipo_cambio_usd_ars";

const admin = createClient(
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

/* --- 1 · La fila ------------------------------------------------------- */

const { data: previa } = await admin
  .from("configuracion")
  .select("clave")
  .eq("clave", CLAVE)
  .maybeSingle();

if (!previa) {
  const { error } = await admin.from("configuracion").insert({
    clave: CLAVE,
    valor: 0,
    descripcion:
      "Pesos por dólar, para mostrar el costo de la IA en moneda local. 0 = sin cargar: " +
      "el tablero no convierte y pide que se cargue. No afecta nada de lo que recibe el vecino.",
    categoria: "panel",
  });
  if (error) mal(`no pude sembrar la fila: ${error.message}`);
  else bien("fila sembrada (no existía)");
} else {
  bien("la fila ya estaba");
}

const { data: fila, error: eFila } = await admin
  .from("configuracion")
  .select("clave, valor, descripcion, categoria, actualizado_en, actualizado_por")
  .eq("clave", CLAVE)
  .maybeSingle();

if (!fila) {
  mal("la fila no existe ni después de sembrarla");
} else {
  if (Number.isFinite(Number(fila.valor))) bien(`el valor es numérico: ${fila.valor}`);
  else mal(`el valor no es un número: ${JSON.stringify(fila.valor)} — el tablero no va a convertir`);

  if (fila.categoria === "panel") bien("categoría 'panel': no es una regla del bot");
  else mal(`categoría '${fila.categoria}', se esperaba 'panel'`);

  if ((fila.descripcion ?? "").length > 20) bien("tiene descripción para el área");
  else mal("sin descripción: la columna es not null pero puede quedar vacía de contenido útil");

  console.log(
    Number(fila.valor) > 0
      ? `  --   cargado en ${fila.valor} pesos por dólar` +
          `${fila.actualizado_por === null ? " — pero nadie lo editó desde el panel" : ""}`
      : "  --   todavía en 0: el tablero muestra sólo dólares y pide que se cargue",
  );
}

/* --- 2 · Que no se lea desde afuera ------------------------------------ */

const anon = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const { data: espia } = await anon.from("configuracion").select("clave").eq("clave", CLAVE);

// El RLS filtra filas en SILENCIO en vez de lanzar un error, así que lo que hay
// que mirar es que vuelva vacío, no que haya explotado.
if ((espia ?? []).length === 0) bien("la clave ANON no la puede leer");
else mal(`la clave ANON leyó ${espia.length} fila(s): la configuración interna está expuesta`);

console.log(fallas === 0 ? "\nTodo en orden." : `\n${fallas} problema(s).`);
process.exit(fallas === 0 ? 0 : 1);
