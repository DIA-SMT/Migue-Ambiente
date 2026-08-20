/** Cadena de conocimiento: respuestas fijas, FAQs y fragmentos de documentos. */
export {
  buscarRespuestaFija,
  buscarEnConocimiento,
  armarContexto,
  idsDeFaqs,
  esMaterialSuficiente,
  type Coincidencia,
  type OrigenConocimiento,
  type OpcionesBusqueda,
} from "./buscar.ts";

export {
  responderConsulta,
  type Respuesta,
  type TrazaRespuesta,
} from "./responder.ts";
