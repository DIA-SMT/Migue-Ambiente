/**
 * Estado de la ingesta en Supabase. Sólo lee.
 *
 *   node --env-file=../../../../.env.local estado.mjs
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const { data: docs } = await supabase
  .from("documentos")
  .select("titulo, formato, estado, paginas, cantidad_fragmentos, error_detalle, bytes")
  .order("titulo");

console.log("DOCUMENTOS");
console.log("  estado      frags  pág  KB     título");
console.log("  " + "-".repeat(72));
for (const d of docs ?? []) {
  console.log(
    "  " +
      d.estado.padEnd(12) +
      String(d.cantidad_fragmentos).padStart(5) +
      String(d.paginas ?? "-").padStart(5) +
      String(Math.round(d.bytes / 1024)).padStart(7) +
      "  " +
      d.titulo.slice(0, 44),
  );
  if (d.error_detalle) console.log(`                 ! ${d.error_detalle.slice(0, 90)}`);
}

const { data: trabajos } = await supabase
  .from("trabajos")
  .select("tipo, estado, intentos, error_detalle")
  .order("creado_en");

const porEstado = new Map();
for (const t of trabajos ?? []) {
  porEstado.set(t.estado, (porEstado.get(t.estado) ?? 0) + 1);
}
console.log("\nCOLA:", [...porEstado].map(([e, n]) => `${e}=${n}`).join("  ") || "vacía");
for (const t of (trabajos ?? []).filter((t) => t.error_detalle)) {
  console.log(`  ! ${t.tipo} (intento ${t.intentos}): ${t.error_detalle.slice(0, 100)}`);
}

const { count } = await supabase.from("fragmentos").select("id", { count: "exact", head: true });
console.log("\nFRAGMENTOS indexados:", count ?? 0);

// ¿Existen ya las funciones de la migración 016?
const { error } = await supabase.rpc("terminar_trabajo", {
  p_id: "00000000-0000-0000-0000-000000000000",
});
const falta = error?.message?.includes("Could not find the function");
console.log("MIGRACIÓN 016:", falta ? "FALTA aplicarla" : "aplicada");
