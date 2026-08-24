/**
 * Prepara el Storage y carga el corpus inicial.
 *
 * Se corre a mano, una vez, para que Migue tenga material desde el primer día.
 * Después de esto los documentos se suben desde el panel.
 *
 *   node --env-file=../../../../.env.local preparar-storage.mjs           (muestra qué haría)
 *   node --env-file=../../../../.env.local preparar-storage.mjs --aplicar (lo hace)
 *
 * Es idempotente: se apoya en el hash del contenido, así que correrlo dos veces
 * no duplica documentos ni vuelve a subir archivos que ya están.
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { claveDeStorage, formatoDe, hashDe } from "../src/ingesta/index.ts";

const aplicar = process.argv.includes("--aplicar");
const BUCKET = process.env.SUPABASE_BUCKET_DOCUMENTOS?.trim() || "documentos";

const url = process.env.SUPABASE_URL?.trim();
const clave = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !clave) {
  console.error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, clave, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORPUS = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? ".",
  "ambiente",
  "corpus",
  "Ambiente - Residuos no Habituales",
);

function buscar(directorio) {
  const encontrados = [];
  for (const entrada of fs.readdirSync(directorio, { withFileTypes: true })) {
    const completa = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) encontrados.push(...buscar(completa));
    else if (/\.(pdf|docx|txt|md)$/i.test(entrada.name) && !entrada.name.startsWith("~$")) {
      encontrados.push(completa);
    }
  }
  return encontrados;
}

/**
 * Título legible a partir del nombre de archivo.
 *
 * Tres de los PDFs del corpus tienen nombre de identificador generado
 * (`QBaZninxWuexyJcS6s0i.pdf`), así que se los mapea a mano: el título es lo que
 * ve el administrador en el panel y lo que Migue cita al vecino.
 */
const TITULOS = {
  "QBaZninxWuexyJcS6s0i.pdf": "Programa CONTROLÁ — Plan Rector 2023-2030",
  "UQNV8gvyAKsepwqXnoBX.pdf": "Programa SE-PA-RÁ — Plan Rector 2023-2030",
  "aonxhSOrXNzurOiYcOWE.pdf": "Programa EDUCÁ — Plan Rector 2023-2030",
  "Especificaciones MVP Ambiente.docx": "Especificación funcional del bot (MVP)",
  "Documento sin título.docx": "Flujos del bot — borrador de trabajo",
  "Bot- ambiente-  recomendaciones respuestas.docx": "Recomendaciones de respuestas del bot",
  "Recomendaciones Bot Ambiente. Puntos Verdes.docx": "Módulo Puntos Verdes — recomendaciones",
  "El workflow para el bot de residuos no habituales, reclamo de no recolección (pasó el recolector y no recogió mi bolsa, o no pasó), debe existir en whatsapp.docx":
    "Workflow de reclamo por falta de recolección",
};

function tituloDe(nombre) {
  if (TITULOS[nombre]) return TITULOS[nombre];
  return nombre.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 1 · El bucket
// ---------------------------------------------------------------------------
const { data: buckets, error: errorListar } = await supabase.storage.listBuckets();
if (errorListar) {
  console.error("No pude listar los buckets:", errorListar.message);
  process.exit(1);
}

const existe = buckets.some((b) => b.name === BUCKET);
console.log(`bucket «${BUCKET}»: ${existe ? "ya existe" : "hay que crearlo"}`);

if (!existe && aplicar) {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    // PRIVADO. Los documentos son públicos como información, pero un bucket
    // público es una URL que se puede enumerar, y acá también van a terminar
    // borradores internos. El bot y el worker leen con la service_role, y el
    // panel puede pedir URLs firmadas cuando haga falta mostrar el archivo.
    public: false,
    allowedMimeTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "text/markdown",
    ],
    // 25 MB. El PDF más grande del corpus pesa menos de 5, y un tope alto
    // convierte un error de carga en una factura de almacenamiento.
    fileSizeLimit: 26_214_400,
  });
  if (error) {
    console.error("No pude crear el bucket:", error.message);
    process.exit(1);
  }
  console.log(`bucket «${BUCKET}» creado (privado, 25 MB por archivo)`);
}

// ---------------------------------------------------------------------------
// 1bis · El bucket de las fotos de vecinos
//
// Separado del de documentos a propósito: otra sensibilidad y, en algún momento,
// otra política de retención. Mezclarlos haría imposible borrar unas sin tocar
// las otras.
// ---------------------------------------------------------------------------
const BUCKET_MEDIA = process.env.SUPABASE_BUCKET_MEDIA?.trim() || "media";
const existeMedia = buckets.some((b) => b.name === BUCKET_MEDIA);
console.log(`bucket «${BUCKET_MEDIA}»: ${existeMedia ? "ya existe" : "hay que crearlo"}`);

if (!existeMedia && aplicar) {
  const { error } = await supabase.storage.createBucket(BUCKET_MEDIA, {
    // PRIVADO, y acá no es discutible: son fotos de la propiedad de un vecino.
    public: false,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "video/mp4", "audio/ogg"],
    // 20 MB es el tope que la API de bots de Telegram permite descargar, así
    // que más que un límite propio es el límite real del canal.
    fileSizeLimit: 20 * 1024 * 1024,
  });
  if (error) {
    console.error("No pude crear el bucket de media:", error.message);
    process.exit(1);
  }
  console.log(`bucket «${BUCKET_MEDIA}» creado (privado, 20 MB por archivo)`);
}

// ---------------------------------------------------------------------------
// 2 · Los documentos
// ---------------------------------------------------------------------------
const archivos = buscar(CORPUS);
console.log(`\ncorpus: ${archivos.length} archivos\n`);

const { data: yaCargados, error: errorDocs } = await supabase
  .from("documentos")
  .select("id, nombre_archivo, hash_sha256, ruta_storage, estado");
if (errorDocs) {
  console.error("No pude leer la tabla documentos:", errorDocs.message);
  process.exit(1);
}

const porHash = new Map((yaCargados ?? []).filter((d) => d.hash_sha256).map((d) => [d.hash_sha256, d]));
const porNombre = new Map((yaCargados ?? []).map((d) => [d.nombre_archivo, d]));

let subidos = 0;
let encolados = 0;
let salteados = 0;

for (const ruta of archivos) {
  const nombre = path.basename(ruta);
  const datos = new Uint8Array(fs.readFileSync(ruta));
  const hash = hashDe(datos);
  const formato = formatoDe(nombre);

  if (porHash.has(hash) || porNombre.has(nombre)) {
    console.log(`  = ${nombre.slice(0, 46).padEnd(46)} ya está cargado`);
    salteados++;
    continue;
  }

  // La clave la arma el dominio: Storage rechaza acentos y nombres larguísimos,
  // y el panel va a tener el mismo problema con los nombres que le den los
  // administradores. Ver `claveDeStorage`.
  const rutaStorage = claveDeStorage(nombre, hash);

  console.log(`  + ${nombre.slice(0, 46).padEnd(46)} ${(datos.length / 1024).toFixed(0)} KB`);
  if (!aplicar) continue;

  const { error: errorSubir } = await supabase.storage.from(BUCKET).upload(rutaStorage, datos, {
    contentType:
      formato === "pdf"
        ? "application/pdf"
        : formato === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "text/plain",
    upsert: true,
  });
  if (errorSubir) {
    console.error(`    no pude subir: ${errorSubir.message}`);
    continue;
  }
  subidos++;

  const { data: documento, error: errorInsertar } = await supabase
    .from("documentos")
    .insert({
      titulo: tituloDe(nombre),
      descripcion: "Carga inicial del corpus de Ambiente",
      nombre_archivo: nombre,
      formato,
      ruta_storage: rutaStorage,
      bytes: datos.length,
      hash_sha256: hash,
      estado: "pendiente",
    })
    .select("id")
    .single();

  if (errorInsertar) {
    console.error(`    no pude registrarlo: ${errorInsertar.message}`);
    continue;
  }

  const { error: errorCola } = await supabase.from("trabajos").insert({
    tipo: "ingestar_documento",
    payload: { documento_id: documento.id },
    // Prioridad alta: es la carga inicial y no hay nada más en la cola.
    prioridad: 50,
  });
  if (errorCola) console.error(`    no pude encolarlo: ${errorCola.message}`);
  else encolados++;
}

console.log();
if (aplicar) {
  console.log(`listo: ${subidos} archivos subidos, ${encolados} encolados, ${salteados} ya estaban`);
  console.log("el worker los procesa cuando arranque (pnpm --filter @bots/migue-ambiente start:worker)");
} else {
  console.log("ensayo: no se tocó nada. Volvé a correrlo con --aplicar para hacerlo.");
}
