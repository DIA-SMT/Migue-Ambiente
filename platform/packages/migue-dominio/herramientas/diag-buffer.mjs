/**
 * ¿pdfjs se queda con el buffer que le pasamos?
 *
 * Hipótesis: `getDocument({ data })` toma posesión del ArrayBuffer y lo deja
 * desacoplado, así que cualquier lectura posterior de ese Uint8Array ve cero
 * bytes. Si es así, calcular el hash DESPUÉS de extraer da el hash del vacío.
 */
import fs from "node:fs";
import path from "node:path";
import { extraerPdf } from "../src/ingesta/pdf.ts";
import { extraerDocx } from "../src/ingesta/docx.ts";
import { hashDe } from "../src/ingesta/extraer.ts";

const base = path.join(
  process.env.USERPROFILE,
  "ambiente/corpus/Ambiente - Residuos no Habituales",
);

const VACIO = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

for (const [etiqueta, ruta, esPdf] of [
  ["PDF  (EDUCÁ)", "Datos de entrenamiento Chatbot Ambiente/aonxhSOrXNzurOiYcOWE.pdf", true],
  ["DOCX (spec)", "Especificaciones MVP Ambiente.docx", false],
]) {
  const datos = new Uint8Array(fs.readFileSync(path.join(base, ruta)));

  const antes = hashDe(datos);
  const largoAntes = datos.length;

  if (esPdf) await extraerPdf(datos);
  else extraerDocx(datos);

  const despues = hashDe(datos);
  const largoDespues = datos.length;

  console.log(etiqueta);
  console.log(`  largo antes / después : ${largoAntes} / ${largoDespues}`);
  console.log(`  hash antes            : ${antes.slice(0, 16)}`);
  console.log(`  hash después          : ${despues.slice(0, 16)}${despues === VACIO ? "   <-- ES EL HASH DEL VACÍO" : ""}`);
  console.log(`  el buffer sobrevivió  : ${antes === despues ? "sí" : "NO"}`);
  console.log(`  ArrayBuffer detached  : ${datos.buffer.detached ?? "(no informado)"}`);
  console.log();
}
