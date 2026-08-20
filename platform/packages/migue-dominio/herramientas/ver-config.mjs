/**
 * Qué se puede cambiar hoy sin tocar código. Sólo lee.
 *
 *   node --env-file=../../../../.env.local herramientas/ver-config.mjs
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const { data: config } = await supabase.from("configuracion").select("*").order("clave");
console.log(`CONFIGURACION — ${config?.length ?? 0} claves\n`);
for (const c of config ?? []) {
  const valor = String(c.valor ?? "").slice(0, 46);
  console.log(`  ${c.clave.padEnd(34)} ${valor.padEnd(48)} ${(c.descripcion ?? "").slice(0, 58)}`);
}

const { data: textos } = await supabase
  .from("textos_bot")
  .select("clave, texto, descripcion")
  .order("clave");
console.log(`\nTEXTOS_BOT — ${textos?.length ?? 0} mensajes editables\n`);
for (const t of textos ?? []) {
  const marcadores = [...String(t.texto).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  console.log(
    `  ${t.clave.padEnd(38)} ${String(t.texto.length).padStart(4)} car.${marcadores.length ? "  marcadores: " + marcadores.join(", ") : ""}`,
  );
}

const { data: faqs } = await supabase.from("faqs").select("id", { count: "exact", head: false });
const { count: nFijas } = await supabase
  .from("respuestas_fijas")
  .select("id", { count: "exact", head: true });
console.log(`\nFAQs cargadas: ${faqs?.length ?? 0}   ·   Respuestas fijas: ${nFijas ?? 0}`);
