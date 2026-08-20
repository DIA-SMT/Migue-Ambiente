/**
 * Limpia la cola y vuelve a encolar la indexación de todos los documentos.
 *
 *   node --env-file=../../../../.env.local herramientas/reindexar.mjs
 *
 * Sirve después de mejorar el fragmentador o de corregir un bug de extracción:
 * los documentos ya están en el Storage, sólo hay que volver a leerlos.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Los trabajos terminados —listos o en error— ya no aportan nada y ensucian la
// lectura de la cola. Los que están en curso no se tocan.
const { error: errorBorrar, count } = await supabase
  .from("trabajos")
  .delete({ count: "exact" })
  .in("estado", ["listo", "error"]);
if (errorBorrar) {
  console.error("no pude limpiar la cola:", errorBorrar.message);
  process.exit(1);
}
console.log(`cola: ${count ?? 0} trabajos terminados borrados`);

// Se sacan las marcas de la corrida anterior para que el estado del panel no
// mienta mientras se reindexa.
const { error: errorLimpiar } = await supabase
  .from("documentos")
  .update({ estado: "pendiente", error_detalle: null })
  .neq("estado", "pendiente");
if (errorLimpiar) {
  console.error("no pude limpiar el estado de los documentos:", errorLimpiar.message);
  process.exit(1);
}

const { data: encolados, error } = await supabase.rpc("encolar_reindexado");
if (error) {
  console.error("no pude encolar:", error.message);
  process.exit(1);
}
console.log(`encolados: ${encolados} documentos para reindexar`);
