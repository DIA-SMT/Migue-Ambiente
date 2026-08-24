/**
 * La cola de trabajos contra Supabase.
 *
 * Las tres operaciones son RPC y no consultas: la toma y el cierre necesitan ser
 * atómicos, y eso sólo se consigue del lado de Postgres. Ver la migración 006
 * (`tomar_trabajo`, con FOR UPDATE SKIP LOCKED) y la 016 (`terminar_trabajo`).
 */
import { createLogger } from "@bots/core";
import { obtenerCliente } from "@migue/dominio";
import { TIPOS_TRABAJO, type TipoTrabajo, type Trabajo } from "@migue/dominio/ingesta";
import type { Cola } from "./bucle.ts";

const log = createLogger("worker:cola");

/** Fila de `trabajos` tal como la devuelve PostgREST. */
interface FilaTrabajo {
  id: string;
  tipo: string;
  payload: Record<string, unknown> | null;
  intentos: number;
  max_intentos: number;
  estado: string;
}


/**
 * La lista viene del dominio, no se repite acá.
 *
 * Antes era un array propio y se desincronizó: `descargar_media` estaba en el
 * check de la tabla y en el bot, pero no en esta lista, así que el worker
 * descartaba las fotos de los vecinos como «tipo desconocido».
 */
function esTipoConocido(tipo: string): tipo is TipoTrabajo {
  return (TIPOS_TRABAJO as readonly string[]).includes(tipo);
}

export function crearCola(): Cola {
  const supabase = obtenerCliente();

  return {
    async tomar(worker: string): Promise<Trabajo | null> {
      // `tomar_trabajo` devuelve `setof trabajos`: cero filas si la cola está
      // vacía, una si tomó algo.
      const { data, error } = await supabase.rpc("tomar_trabajo", { p_worker: worker });
      if (error) throw new Error(error.message);

      const filas = (data ?? []) as FilaTrabajo[];
      const fila = filas[0];
      if (fila === undefined) return null;

      if (!esTipoConocido(fila.tipo)) {
        // El check de la tabla lo impide, así que llegar acá significa que se
        // agregó un tipo en la base y no en el código. Se avisa fuerte en vez de
        // dejarlo en 'tomado' para siempre.
        log.error({ tipo: fila.tipo, id: fila.id }, "tipo de trabajo desconocido");
        await supabase.rpc("terminar_trabajo", {
          p_id: fila.id,
          p_error: `El worker no conoce el tipo «${fila.tipo}»; hay que actualizarlo`,
          p_definitivo: true,
        });
        return null;
      }

      return {
        id: fila.id,
        tipo: fila.tipo,
        payload: fila.payload ?? {},
        intentos: fila.intentos,
        maxIntentos: fila.max_intentos,
      };
    },

    async terminar(id, error, definitivo = false) {
      const { data, error: fallo } = await supabase.rpc("terminar_trabajo", {
        p_id: id,
        p_error: error ?? null,
        p_definitivo: definitivo,
      });
      if (fallo) throw new Error(fallo.message);

      // `terminar_trabajo` devuelve la fila completa; alcanza con el estado y
      // los intentos para poder registrar qué pasó.
      const fila = (Array.isArray(data) ? data[0] : data) as FilaTrabajo | undefined;
      return { estado: fila?.estado ?? "desconocido", intentos: fila?.intentos ?? 0 };
    },

    async recuperarColgados(): Promise<number> {
      const { data, error } = await supabase.rpc("recuperar_trabajos_colgados");
      if (error) throw new Error(error.message);
      return typeof data === "number" ? data : 0;
    },
  };
}
