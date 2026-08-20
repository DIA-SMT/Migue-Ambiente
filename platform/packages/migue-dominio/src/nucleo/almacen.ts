/**
 * Almacén del estado de flujo.
 *
 * Detrás de una interfaz y no acoplado a Redis por dos razones:
 *
 *   1. El orquestador se puede testear entero con la implementación en memoria,
 *      sin levantar Redis ni esperar tiempos de espera de red.
 *   2. Si mañana el estado tiene que vivir en otro lado —Postgres, o el propio
 *      canal— se cambia la implementación y no el orquestador.
 *
 * El estado de flujo es CALIENTE y descartable: si Redis se vacía, las
 * conversaciones a medias se pierden y el vecino vuelve a empezar. Molesto,
 * pero no grave. Lo durable —tickets, mensajes, trazas— vive en Supabase.
 */
import type { EstadoFlujo } from "../flujos/tipos.ts";

export interface AlmacenEstado {
  leer(clave: string): Promise<EstadoFlujo | null>;
  guardar(clave: string, estado: EstadoFlujo): Promise<void>;
  borrar(clave: string): Promise<void>;
}

/**
 * Clave del estado.
 *
 * Incluye el canal a propósito: la misma persona escribiendo por Telegram y por
 * WhatsApp son dos conversaciones distintas, y mezclarlas dejaría un flujo a
 * medias respondiendo a mensajes del otro canal.
 */
export function claveDeEstado(canal: string, canalUsuarioId: string): string {
  return `flujo:${canal}:${canalUsuarioId}`;
}

// ---------------------------------------------------------------------------
// En memoria · para pruebas
// ---------------------------------------------------------------------------

export function almacenEnMemoria(): AlmacenEstado & { readonly tamano: () => number } {
  const mapa = new Map<string, EstadoFlujo>();
  return {
    async leer(clave) {
      return mapa.get(clave) ?? null;
    },
    async guardar(clave, estado) {
      mapa.set(clave, estado);
    },
    async borrar(clave) {
      mapa.delete(clave);
    },
    tamano: () => mapa.size,
  };
}

// ---------------------------------------------------------------------------
// Redis · producción
// ---------------------------------------------------------------------------

/** Contrato mínimo que necesita el almacén. Lo cumple `ioredis`. */
export interface ClienteRedis {
  get(clave: string): Promise<string | null>;
  set(clave: string, valor: string, modo: "EX", segundos: number): Promise<unknown>;
  del(clave: string): Promise<unknown>;
}

/**
 * Vencimiento del estado de flujo.
 *
 * Dos horas. Un vecino que dejó un pedido a medias y vuelve al otro día no
 * quiere seguir contestando preguntas de ayer: quiere empezar de nuevo. Y un
 * estado que no vence nunca deja basura en Redis por cada conversación
 * abandonada.
 */
const TTL_SEGUNDOS = 2 * 60 * 60;

export function almacenRedis(cliente: ClienteRedis, ttlSegundos = TTL_SEGUNDOS): AlmacenEstado {
  return {
    async leer(clave) {
      const crudo = await cliente.get(clave);
      if (crudo === null) return null;
      try {
        return JSON.parse(crudo) as EstadoFlujo;
      } catch {
        // Un estado corrupto —por un cambio de formato, por ejemplo— se
        // descarta en silencio. El vecino vuelve a empezar, que es mejor que
        // que el bot quede atascado en un estado que no puede interpretar.
        await cliente.del(clave);
        return null;
      }
    },

    async guardar(clave, estado) {
      await cliente.set(clave, JSON.stringify(estado), "EX", ttlSegundos);
    },

    async borrar(clave) {
      await cliente.del(clave);
    },
  };
}
