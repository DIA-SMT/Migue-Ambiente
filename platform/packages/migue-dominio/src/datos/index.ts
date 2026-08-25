/** Acceso a datos. Todo pasa por Supabase con la clave de servicio. */
export {
  obtenerCliente,
  reiniciarCliente,
  verificarConexion,
  ConfiguracionFaltanteError,
} from "./cliente.ts";

export { CacheConVencimiento, TTL_REGLAS_MS, type OpcionesCache } from "./cache.ts";

export {
  obtenerCatalogo,
  invalidarCatalogo,
  leerConfig,
  leerTexto,
  tieneTexto,
  configSla,
  describirPuntosVerdes,
  ErrorDeCatalogo,
  type Catalogo,
  type PuntoVerde,
  type ZonaRecoleccion,
} from "./catalogo.ts";

export {
  obtenerOAbrirConversacion,
  registrarEntrante,
  registrarSaliente,
  actualizarFlujo,
  cerrarConversacion,
  ErrorDeEscritura,
  type Conversacion,
  type OrigenRespuesta,
  type TrazaMensaje,
} from "./conversaciones.ts";

export {
  crearTicket,
  crearSolicitudPrograma,
  registrarSinRespuesta,
  type Procedencia,
  type MotivoSinRespuesta,
} from "./registros.ts";

export {
  aplicarEfectos,
  huboFallas,
  idDeTicket,
  type ResultadoEfecto,
} from "./efectos.ts";

export { registrarVoto, comentarVoto } from "./valoraciones.ts";
