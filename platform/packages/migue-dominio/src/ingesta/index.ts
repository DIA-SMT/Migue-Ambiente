/**
 * Ingesta de documentos: de un archivo subido al panel a fragmentos buscables.
 *
 * El worker es el único que usa esto. El bot no ingesta nada: sólo lee los
 * fragmentos ya indexados.
 */
export {
  extraer,
  formatoDe,
  hashDe,
  FormatoNoSoportadoError,
  SinTextoError,
  type Formato,
  type ResultadoExtraccion,
} from "./extraer.ts";

export { claveDeStorage } from "./clave.ts";
export { extraerPdf, type DocumentoExtraido } from "./pdf.ts";
export { extraerDocx } from "./docx.ts";
export { fragmentar, type FragmentoIndexable, type OpcionesFragmentar } from "./fragmentar.ts";

export {
  procesarTrabajo,
  PayloadInvalidoError,
  TIPOS_TRABAJO,
  type DocumentoARindexar,
  type PuertosIngesta,
  type ResultadoTrabajo,
  type Trabajo,
  type TipoTrabajo,
} from "./procesar.ts";

export {
  limpiar,
  marcarTitulo,
  MARCA_TITULO,
  pareceTitulo,
  quitarMarca,
  esTituloMarcado,
} from "./texto.ts";
