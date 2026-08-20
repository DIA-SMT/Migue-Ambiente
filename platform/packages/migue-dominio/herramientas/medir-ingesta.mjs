/**
 * Medición de la ingesta sobre el corpus real.
 *
 * Se corre a mano cuando se toca algo de `src/ingesta/`. No es un test: los
 * tests verifican reglas, esto muestra qué le pasa a los documentos de verdad.
 *
 *   node herramientas/medir-ingesta.mjs
 *   node herramientas/medir-ingesta.mjs --detalle
 */
import fs from "node:fs";
import path from "node:path";
import { extraerPdf } from "../src/ingesta/pdf.ts";
import { extraerDocx } from "../src/ingesta/docx.ts";
import { fragmentar } from "../src/ingesta/fragmentar.ts";
import { MARCA_TITULO } from "../src/ingesta/texto.ts";

const CORPUS = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? ".",
  "ambiente",
  "corpus",
  "Ambiente - Residuos no Habituales",
);

const detalle = process.argv.includes("--detalle");

/** Busca todos los PDF y DOCX del corpus, en cualquier subcarpeta. */
function buscarDocumentos(directorio) {
  const encontrados = [];
  for (const entrada of fs.readdirSync(directorio, { withFileTypes: true })) {
    const completa = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      encontrados.push(...buscarDocumentos(completa));
    } else if (/\.(pdf|docx)$/i.test(entrada.name) && !entrada.name.startsWith("~$")) {
      encontrados.push(completa);
    }
  }
  return encontrados;
}

const documentos = buscarDocumentos(CORPUS);
console.log(`corpus: ${documentos.length} documentos en ${CORPUS}\n`);

const fila = (c) =>
  c[0].padEnd(34) +
  String(c[1]).padStart(4) +
  String(c[2]).padStart(7) +
  String(c[3]).padStart(5) +
  String(c[4]).padStart(5) +
  String(c[5]).padStart(5) +
  String(c[6]).padStart(11) +
  String(c[7]).padStart(6);

console.log(fila(["documento", "pág", "frags", "mín", "med", "máx", "secciones", "ms"]));
console.log("-".repeat(77));

let totalFragmentos = 0;
const problemas = [];

for (const ruta of documentos) {
  const nombre = path.basename(ruta);
  const datos = new Uint8Array(fs.readFileSync(ruta));
  const arranque = performance.now();

  let extraido;
  try {
    extraido = nombre.toLowerCase().endsWith(".pdf")
      ? await extraerPdf(datos)
      : extraerDocx(datos);
  } catch (error) {
    problemas.push(`${nombre}: falló la extracción — ${error.message}`);
    continue;
  }

  const fragmentos = fragmentar(extraido.paginas);
  const ms = Math.round(performance.now() - arranque);
  totalFragmentos += fragmentos.length;

  const largos = fragmentos.map((f) => f.texto.length);
  const secciones = new Set(fragmentos.map((f) => f.tituloSeccion));

  console.log(
    fila([
      nombre.length > 33 ? nombre.slice(0, 30) + "..." : nombre,
      extraido.cantidadPaginas,
      fragmentos.length,
      largos.length ? Math.min(...largos) : 0,
      largos.length ? Math.round(largos.reduce((a, b) => a + b, 0) / largos.length) : 0,
      largos.length ? Math.max(...largos) : 0,
      secciones.size,
      ms,
    ]),
  );

  // Lo que nunca tiene que pasar, verificado en cada documento del corpus.
  for (const f of fragmentos) {
    if (f.texto.includes(MARCA_TITULO) || (f.tituloSeccion ?? "").includes(MARCA_TITULO)) {
      problemas.push(`${nombre}: fragmento ${f.orden} se guardó con la marca de título`);
    }
    if (/[.]{6,}/.test(f.texto)) {
      problemas.push(`${nombre}: fragmento ${f.orden} es índice y quedó indexado`);
    }
    // Se arma con RegExp para no escribir caracteres de control en el fuente.
    if (new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]").test(f.texto)) {
      problemas.push(`${nombre}: fragmento ${f.orden} tiene caracteres de control`);
    }
  }
  const ordenes = fragmentos.map((f) => f.orden);
  if (ordenes.some((o, i) => o !== i + 1)) {
    problemas.push(`${nombre}: el orden de los fragmentos no es contiguo`);
  }

  if (detalle) {
    for (const f of fragmentos) {
      console.log(
        `      [${String(f.texto.length).padStart(4)}] p${String(f.pagina).padStart(2)} «${f.tituloSeccion}»`,
      );
      console.log(`             ${f.texto.replace(/\n/g, " / ").slice(0, 150)}`);
    }
    console.log();
  }
}

console.log();
console.log(`total: ${totalFragmentos} fragmentos indexables`);

if (problemas.length > 0) {
  console.log();
  console.log(`PROBLEMAS (${problemas.length}):`);
  for (const p of problemas) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log("sin problemas: ninguna marca filtrada, ningún índice indexado, orden contiguo");
}
