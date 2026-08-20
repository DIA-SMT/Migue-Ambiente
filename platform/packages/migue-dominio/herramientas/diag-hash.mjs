/**
 * Diagnóstico: compara el hash guardado en `documentos` con el hash real del
 * archivo que está en el Storage. Sólo lee.
 */
import { createClient } from "@supabase/supabase-js";
import { hashDe } from "../src/ingesta/index.ts";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const BUCKET = process.env.SUPABASE_BUCKET_DOCUMENTOS?.trim() || "documentos";

const { data: docs } = await supabase
  .from("documentos")
  .select("id, titulo, nombre_archivo, ruta_storage, hash_sha256, estado, error_detalle")
  .order("titulo");

console.log("guardado  real      coincide  estado      título");
console.log("-".repeat(78));

const realPorHash = new Map();

for (const d of docs) {
  const { data, error } = await supabase.storage.from(BUCKET).download(d.ruta_storage);
  if (error) {
    console.log(
      `${(d.hash_sha256 ?? "-").slice(0, 8)}  ???       ---       ${d.estado.padEnd(11)} ${d.titulo.slice(0, 34)}  (no está en Storage: ${error.message})`,
    );
    continue;
  }
  const real = hashDe(new Uint8Array(await data.arrayBuffer()));
  const coincide = real === d.hash_sha256;
  console.log(
    `${(d.hash_sha256 ?? "-").slice(0, 8)}  ${real.slice(0, 8)}  ${coincide ? "sí      " : "NO      "}  ${d.estado.padEnd(11)} ${d.titulo.slice(0, 34)}`,
  );
  realPorHash.set(real, [...(realPorHash.get(real) ?? []), d.titulo]);
}

console.log("\nHASHES REALES REPETIDOS (contenido idéntico con nombres distintos):");
let hay = false;
for (const [hash, titulos] of realPorHash) {
  if (titulos.length > 1) {
    hay = true;
    console.log(`  ${hash.slice(0, 12)} lo comparten ${titulos.length}:`);
    for (const t of titulos) console.log(`     - ${t}`);
  }
}
if (!hay) console.log("  ninguno");

console.log("\nHASHES GUARDADOS REPETIDOS:");
const guardados = new Map();
for (const d of docs) {
  if (!d.hash_sha256) continue;
  guardados.set(d.hash_sha256, (guardados.get(d.hash_sha256) ?? 0) + 1);
}
const repes = [...guardados].filter(([, n]) => n > 1);
console.log(repes.length ? repes.map(([h, n]) => `  ${h.slice(0, 12)} x${n}`).join("\n") : "  ninguno");
