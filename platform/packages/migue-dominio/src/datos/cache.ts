/**
 * Caché con vencimiento para los datos que el bot lee en CADA mensaje.
 *
 * Reglas, límites, textos y configuración cambian poquísimo —un operador edita
 * un texto cada tantos días— pero se consultan en cada mensaje que llega. Sin
 * caché, cada "hola" son seis viajes a Supabase.
 *
 * El vencimiento es lo que hace que una edición del panel se refleje sin
 * reiniciar el bot. Con TTL de 60 s, el operador corrige un texto y en menos de
 * un minuto ya está en producción, sin deploy y sin avisarle a nadie.
 */

export interface OpcionesCache {
  /** Milisegundos de validez. */
  readonly ttlMs: number;
  /**
   * Si la recarga falla y hay un valor viejo, ¿se sigue usando?
   *
   * Por defecto sí, y es deliberado: ante una caída momentánea de Supabase,
   * seguir respondiendo con reglas de hace dos minutos es mucho mejor que
   * dejar de responderle a los vecinos.
   */
  readonly servirVencidoSiFalla?: boolean;
}

export class CacheConVencimiento<T> {
  #valor: T | undefined;
  #cargadoEn = 0;
  /** Carga en vuelo, para que N llamadas simultáneas hagan UNA sola consulta. */
  #enVuelo: Promise<T> | null = null;

  readonly #cargar: () => Promise<T>;
  readonly #ttlMs: number;
  readonly #servirVencidoSiFalla: boolean;

  constructor(cargar: () => Promise<T>, opciones: OpcionesCache) {
    this.#cargar = cargar;
    this.#ttlMs = opciones.ttlMs;
    this.#servirVencidoSiFalla = opciones.servirVencidoSiFalla ?? true;
  }

  get vencido(): boolean {
    return this.#valor === undefined || Date.now() - this.#cargadoEn >= this.#ttlMs;
  }

  async obtener(): Promise<T> {
    if (!this.vencido) return this.#valor as T;

    // Sin esta coalescencia, un bot que arranca y recibe veinte mensajes de
    // golpe dispara veinte consultas idénticas a la misma tabla.
    if (this.#enVuelo) return this.#enVuelo;

    this.#enVuelo = this.#cargar()
      .then((valor) => {
        this.#valor = valor;
        this.#cargadoEn = Date.now();
        return valor;
      })
      .catch((error: unknown) => {
        if (this.#servirVencidoSiFalla && this.#valor !== undefined) {
          // Se sirve el valor viejo, pero NO se refresca `cargadoEn`: el
          // próximo pedido vuelve a intentar la recarga.
          return this.#valor;
        }
        throw error;
      })
      .finally(() => {
        this.#enVuelo = null;
      });

    return this.#enVuelo;
  }

  /** Invalida sin recargar. La próxima lectura va a la base. */
  invalidar(): void {
    this.#cargadoEn = 0;
  }

  /** Descarta el valor por completo, incluido el respaldo para fallas. */
  vaciar(): void {
    this.#valor = undefined;
    this.#cargadoEn = 0;
  }
}

/** TTL por defecto de los datos administrables. */
export const TTL_REGLAS_MS = 60_000;
