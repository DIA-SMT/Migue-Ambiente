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
