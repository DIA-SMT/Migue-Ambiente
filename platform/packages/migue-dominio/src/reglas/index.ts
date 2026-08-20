/** Reglas de negocio. Funciones puras: reciben datos, devuelven decisiones. */
export {
  evaluarExclusiones,
  evaluarTodasLasExclusiones,
  corta,
  type AccionExclusion,
  type ReglaExclusion,
  type CoincidenciaExclusion,
} from "./exclusiones.ts";

export {
  interpretarCantidad,
  esUtilizable,
  type Unidad,
  type TerminoVago,
  type CantidadDeclarada,
} from "./cantidad.ts";

export {
  validarVolumen,
  preguntaParaPrecisar,
  limiteDe,
  type Categoria,
  type AccionExceso,
  type LimiteVolumen,
  type MotivoPrecision,
  type ResultadoVolumen,
} from "./volumen.ts";

export {
  calcularVencimiento,
  describirPlazo,
  esDiaHabil,
  formatearFechaLocal,
  CONFIG_SLA_POR_DEFECTO,
  type ConfigSla,
  type ModoSla,
} from "./sla.ts";
