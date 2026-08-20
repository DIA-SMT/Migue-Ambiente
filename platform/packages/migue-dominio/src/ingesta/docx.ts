/**
 * Extracción de texto de DOCX.
 *
 * Un DOCX es un ZIP con XML adentro, así que no hace falta una librería de
 * ofimática: alcanza con descomprimir y leer `word/document.xml`. Se usa
 * `fflate` sólo para el inflate, que es la única parte que no vale la pena
 * escribir a mano.
 *
 * Se extraen párrafos y celdas de tabla. Las tablas importan: en los borradores
 * de Ambiente los límites de volumen y los horarios están en tablas, y perderlas
 * dejaría afuera justo los datos operativos.
 */
import { unzipSync, strFromU8 } from "fflate";
import { limpiar, MARCA_TITULO } from "./texto.ts";
import type { DocumentoExtraido } from "./pdf.ts";

/** Entidades XML que aparecen en un document.xml de Word. */
function decodificarEntidades(texto: string): string {
  return texto
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    // El & va al final: si se decodificara primero, un «&amp;lt;» se
    // convertiría en «<» en vez de en «&lt;».
    .replace(/&amp;/g, "&");
}

/**
 * Estilos de párrafo que Word usa para los encabezados.
 *
 * Word nombra los estilos según el idioma en que se creó el documento: en
 * inglés «Heading1», en español «Ttulo1» —sin la tilde, porque el nombre
 * interno del estilo va sin acentos— o «Titulo1». Se aceptan las tres formas
 * porque los documentos de Ambiente van a llegar de máquinas distintas.
 */
const ESTILOS_DE_TITULO = /^(heading|t[ií]tulo|ttulo|subtitle|subt[ií]tulo|subttulo)/i;

/**
 * Marca los párrafos que Word declaró como encabezado.
 *
 * Esto es información DURA, no una heurística: el estilo del párrafo lo puso
 * quien escribió el documento. Medido sobre la especificación del MVP, el
 * archivo declara 9 encabezados con estilo, y adivinando por el texto se
 * detectaban 3.
 *
 * Se inserta la marca justo después de la etiqueta de apertura del párrafo, de
 * modo que cuando `xmlATexto` saque todas las etiquetas la marca quede al
 * principio de la línea, que es donde el fragmentador la busca.
 */
function marcarEncabezados(xml: string): string {
  return xml.replace(/<w:p\b[^>]*>/g, (apertura, posicion: number) => {
    // El w:pPr con el estilo está dentro del párrafo, así que hay que mirar
    // hacia adelante, hasta donde ese párrafo termina.
    const cierre = xml.indexOf("</w:p>", posicion);
    const cuerpo = xml.slice(posicion, cierre === -1 ? undefined : cierre);
    const estilo = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(cuerpo);
    if (estilo === null || !ESTILOS_DE_TITULO.test(estilo[1]!)) return apertura;
    return apertura + MARCA_TITULO;
  });
}

/**
 * Convierte el XML de Word en texto con párrafos.
 *
 * Se resuelve con reemplazos y no con un parser de XML porque la estructura que
 * interesa es mínima: `w:p` es un párrafo, `w:tab` un tabulador, `w:br` un
 * salto. Un parser completo agregaría una dependencia grande para distinguir
 * cosas que no usamos.
 */
function xmlATexto(xml: string): string {
  return decodificarEntidades(
    marcarEncabezados(xml)
      // Cada párrafo y cada fila de tabla arrancan una línea nueva
      .replace(/<w:p[ >]/g, "\n<w:p ")
      .replace(/<\/w:tr>/g, "\n")
      // Separadores dentro de un párrafo
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<w:br\b[^>]*\/?>/g, "\n")
      // Las celdas se separan con un guion para que la fila se lea como fila
      .replace(/<\/w:tc>\s*<w:tc[ >]/g, " — <w:tc ")
      // Y ahora sí, fuera todas las etiquetas
      .replace(/<[^>]+>/g, ""),
  );
}

export function extraerDocx(datos: Uint8Array): DocumentoExtraido {
  const archivos = unzipSync(datos, {
    // Sólo se descomprime lo que se va a leer: un DOCX con imágenes puede
    // pesar megabytes que no aportan texto.
    filter: (archivo) =>
      archivo.name === "word/document.xml" ||
      archivo.name === "word/footnotes.xml" ||
      archivo.name === "word/endnotes.xml",
  });

  const principal = archivos["word/document.xml"];
  if (principal === undefined) {
    throw new Error("el archivo no parece un DOCX: falta word/document.xml");
  }

  const partes = [xmlATexto(strFromU8(principal))];

  // Las notas al pie llevan aclaraciones que a veces son el dato operativo.
  for (const nombre of ["word/footnotes.xml", "word/endnotes.xml"]) {
    const nota = archivos[nombre];
    if (nota) {
      const texto = xmlATexto(strFromU8(nota)).trim();
      if (texto !== "") partes.push(`Notas:\n${texto}`);
    }
  }

  // Un DOCX no tiene páginas: la paginación la calcula Word al renderizar. Se
  // trata como una sola página y el fragmentador se encarga de cortarlo.
  const paginas = limpiar([partes.join("\n\n")]);
  return { paginas, cantidadPaginas: 1 };
}
