/**
 * Formatos de documento admitidos.
 *
 * Vive en su propio módulo, separado de `extraer.ts`, por un motivo concreto:
 * el panel corre en el navegador y necesita validar el formato de un archivo
 * antes de subirlo. Si `formatoDe` siguiera dentro de `extraer.ts`, importarlo
 * arrastraría `pdfjs-dist`, `fflate` y `node:crypto` al bundle del navegador —
 * megabytes de un extractor de PDF que en el navegador no se usa, y un módulo
 * de Node que ahí no existe.
 *
 * Sin dependencias, ni de paquetes ni de Node. Es lo que lo hace compartible.
 */

/** Formatos que acepta la columna `documentos.formato`. */
export type Formato = "pdf" | "docx" | "txt" | "md";

export class FormatoNoSoportadoError extends Error {
  constructor(nombreArchivo: string) {
    super(
      `No se puede leer «${nombreArchivo}»: sólo se admiten PDF, DOCX, TXT y MD. ` +
        `Si es un documento escaneado, hay que pasarlo por un OCR antes de subirlo.`,
    );
    this.name = "FormatoNoSoportadoError";
  }
}

/** Deduce el formato por la extensión del nombre de archivo. */
export function formatoDe(nombreArchivo: string): Formato {
  const extension = nombreArchivo.toLowerCase().split(".").pop() ?? "";
  if (extension === "pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (extension === "txt") return "txt";
  if (extension === "md" || extension === "markdown") return "md";
  throw new FormatoNoSoportadoError(nombreArchivo);
}

/** El mime que corresponde a cada formato, para subir a Supabase Storage. */
export function mimeDe(formato: Formato): string {
  switch (formato) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
  }
}
