/** Motor de flujos y los cuatro flujos de la Especificación Funcional MVP. */
export {
  iniciarFlujo,
  avanzarFlujo,
  quiereSalir,
  cancelar,
  FlujoDesconocidoError,
  PasoDesconocidoError,
} from "./motor.ts";

export { flujoRetiroNoHabitual } from "./retiroNoHabitual.ts";
export { flujoReclamoRecoleccion } from "./reclamoRecoleccion.ts";
export { flujoPedirAsesor } from "./pedirAsesor.ts";
export {
  flujoProgramaEduca,
  flujoProgramaTransforma,
  flujoProgramaSepara,
  flujosDeProgramas,
} from "./programas.ts";

export type {
  NombreFlujo,
  EstadoFlujo,
  DatosFlujo,
  DatosTicket,
  DatosSolicitudPrograma,
  DatosAlertaAsesor,
  Efecto,
  ContextoFlujo,
  Transicion,
  DefinicionPaso,
  DefinicionFlujo,
  ResultadoAvance,
} from "./tipos.ts";
