/**
 * Punto único de extracción: recibe bytes y un nombre de archivo, devuelve
 * fragmentos indexables.
 *
 * Existe para que el worker no tenga que saber qué extractor corresponde a cada
 * formato. Toda la decisión vive acá.
 */
import { createHash } from "node:crypto";
import { extraerDocx } from "./docx.ts";
import { extraerPdf, type DocumentoExtraido } from "./pdf.ts";
import { fragmentar, type FragmentoIndexable } from "./fragmentar.ts";
import { formatoDe, mimeDe, FormatoNoSoportadoError, type Formato } from "./formato.ts";
import { limpiar } from "./texto.ts";

// Se reexportan para no romper a quien los importaba de acá. La definición vive
// en `formato.ts`, que no depende de nada y por eso lo puede usar el panel.
export { formatoDe, mimeDe, FormatoNoSoportadoError, type Formato };

export interface ResultadoExtraccion {
  readonly fragmentos: readonly FragmentoIndexable[];
  readonly cantidadPaginas: number;
  readonly hash: string;
  /** Caracteres de texto útil. Sirve para detectar un PDF escaneado. */
  readonly caracteres: number;
}

/**
 * Un documento del que no se pudo sacar texto.
 *
 * Casi siempre es un PDF escaneado: son imágenes de páginas sin capa de texto.
 * El mensaje lo lee un administrador en el panel, no un programador, así que
 * dice qué hacer.
 */
export class SinTextoError extends Error {
  constructor(nombreArchivo: string) {
    super(
      `«${nombreArchivo}» no tiene texto que se pueda leer. ` +
        `Lo más común es que sea un PDF escaneado: son imágenes de páginas, sin ` +
        `capa de texto, y hay que pasarlos por un OCR antes de subirlos.`,
    );
    this.name = "SinTextoError";
  }
}

/**
 * Un TXT o MD no tiene páginas ni estilos, así que sólo se limpia y se pasa al
 * fragmentador, que va a etiquetar las secciones con la heurística de texto.
 */
function extraerPlano(datos: Uint8Array): DocumentoExtraido {
  const texto = new TextDecoder("utf-8").decode(datos);
  return { paginas: limpiar([texto]), cantidadPaginas: 1 };
}

/**
 * Hash del CONTENIDO, no del nombre.
 *
 * Es lo que permite detectar que el mismo archivo se subió dos veces con
 * nombres distintos, que es exactamente lo que pasa cuando alguien renombra un
 * documento y lo vuelve a subir. La columna `documentos.hash_sha256` tiene un
 * índice único parcial.
 */
export function hashDe(datos: Uint8Array): string {
  return createHash("sha256").update(datos).digest("hex");
}

/**
 * Cuánto texto tiene que salir para creer que el documento se leyó bien.
 *
 * 200 caracteres es menos que un párrafo. Por debajo de eso no es un documento
 * corto: es un PDF escaneado, y conviene decirlo con un mensaje claro en vez de
 * indexar cero fragmentos y dejar al administrador adivinando.
 */
const MINIMO_DE_TEXTO = 200;

export async function extraer(
  datos: Uint8Array,
  nombreArchivo: string,
  formato: Formato = formatoDe(nombreArchivo),
): Promise<ResultadoExtraccion> {
  // EL HASH VA PRIMERO, y no es una preferencia de estilo.
  //
  // `pdfjs` se apropia del ArrayBuffer que recibe y lo deja desacoplado: después
  // de `extraerPdf`, el mismo Uint8Array mide cero bytes. Calculando el hash
  // después, todo PDF quedaba guardado con el hash del contenido vacío
  // (e3b0c442…), y como `documentos.hash_sha256` tiene un índice único, el
  // segundo PDF chocaba contra el primero y no se indexaba nunca.
  //
  // Se descubrió indexando el corpus real: de tres PDFs, uno quedó con el hash
  // del vacío y los otros dos fallaron con «duplicate key value violates unique
  // constraint». Los DOCX no lo mostraban porque `fflate` no toma posesión.
  const hash = hashDe(datos);

  let extraido: DocumentoExtraido;

  switch (formato) {
    case "pdf":
      extraido = await extraerPdf(datos);
      break;
    case "docx":
      extraido = extraerDocx(datos);
      break;
    case "txt":
    case "md":
      extraido = extraerPlano(datos);
      break;
    default: {
      // Si alguien agrega un formato a la tabla y se olvida de agregarlo acá,
      // TypeScript marca el error en esta línea.
      const nunca: never = formato;
      throw new FormatoNoSoportadoError(String(nunca));
    }
  }

  const caracteres = extraido.paginas.join("").replace(/\s/g, "").length;
  if (caracteres < MINIMO_DE_TEXTO) throw new SinTextoError(nombreArchivo);

  return {
    fragmentos: fragmentar(extraido.paginas),
    cantidadPaginas: extraido.cantidadPaginas,
    hash,
    caracteres,
  };
}
