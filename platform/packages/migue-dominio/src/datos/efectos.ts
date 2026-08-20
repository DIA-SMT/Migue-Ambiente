/**
 * Ejecución de los efectos declarados por el motor de flujos.
 *
 * Es la única frontera donde la lógica pura se vuelve escritura. El motor
 * devuelve efectos como datos —«crear este ticket», «guardar esta foto»— y este
 * módulo los aplica. Esa separación es lo que permite testear los flujos
 * completos sin base de datos.
 *
 * Regla del módulo: NINGÚN efecto que falle puede tumbar la conversación.
 * Si el ticket no se pudo guardar, el vecino ya recibió la confirmación —el
 * mensaje se envía antes— y dejarlo colgado sería peor. Los fallos se devuelven
 * para que el orquestador los registre y alguien los revise.
 */
import { obtenerCliente } from "./cliente.ts";
import { cerrarConversacion } from "./conversaciones.ts";
import { crearSolicitudPrograma, crearTicket, type Procedencia } from "./registros.ts";
import type { Efecto } from "../flujos/tipos.ts";

export interface ResultadoEfecto {
  readonly efecto: Efecto["tipo"];
  readonly ok: boolean;
  /** Id de la fila creada, cuando el efecto crea una. */
  readonly id?: string;
  readonly error?: string;
}

/**
 * Aplica todos los efectos y devuelve qué pasó con cada uno.
 *
 * Se aplican EN SERIE y no en paralelo. No es por prudencia genérica: los
 * efectos de un mismo turno pueden depender del orden —cerrar la conversación
 * después de crear el ticket, no antes— y un `Promise.all` no da esa garantía.
 */
export async function aplicarEfectos(
  efectos: readonly Efecto[],
  procedencia: Procedencia,
): Promise<ResultadoEfecto[]> {
  const resultados: ResultadoEfecto[] = [];

  // `cerrar_conversacion` va último siempre: si se aplicara antes, el ticket
  // quedaría apuntando a una conversación ya cerrada.
  const ordenados = [...efectos].sort(
    (a, b) => Number(a.tipo === "cerrar_conversacion") - Number(b.tipo === "cerrar_conversacion"),
  );

  for (const efecto of ordenados) {
    try {
      resultados.push(await aplicarUno(efecto, procedencia));
    } catch (error) {
      // No se relanza: un efecto fallido no puede cortar la conversación ni
      // impedir que se apliquen los demás.
      resultados.push({
        efecto: efecto.tipo,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return resultados;
}

async function aplicarUno(efecto: Efecto, procedencia: Procedencia): Promise<ResultadoEfecto> {
  switch (efecto.tipo) {
    case "crear_ticket": {
      const id = await crearTicket(efecto.datos, procedencia);
      return { efecto: efecto.tipo, ok: true, id };
    }

    case "crear_solicitud_programa": {
      const id = await crearSolicitudPrograma(efecto.datos, procedencia);
      return { efecto: efecto.tipo, ok: true, id };
    }

    case "guardar_media": {
      const id = await encolarDescarga(efecto.referencia, efecto.proposito, procedencia);
      return { efecto: efecto.tipo, ok: true, id };
    }

    case "cerrar_conversacion": {
      if (procedencia.conversacionId !== null) {
        const estado = efecto.motivo.startsWith("cancelado") ? "cerrada" : "abandonada";
        await cerrarConversacion(procedencia.conversacionId, estado);
      }
      return { efecto: efecto.tipo, ok: true };
    }
  }
}

/**
 * Encola la descarga de una foto para el worker.
 *
 * El flujo guarda la referencia del canal y sigue; la descarga la hace el
 * worker. Es lo que evita que un vecino espere a que bajen 5 MB de una foto
 * antes de recibir la confirmación de su pedido.
 */
async function encolarDescarga(
  referencia: string,
  proposito: string,
  procedencia: Procedencia,
): Promise<string> {
  const { data, error } = await obtenerCliente()
    .from("trabajos")
    .insert({
      tipo: "descargar_media",
      // `prioridad` menor gana. Las fotos de vecinos van antes que la ingesta
      // de documentos del panel: acá hay alguien esperando del otro lado.
      prioridad: 10,
      payload: {
        clase: "media_de_canal",
        referencia,
        proposito,
        canal: procedencia.canal,
        conversacion_id: procedencia.conversacionId,
      },
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`no pude encolar la descarga de media: ${error?.message ?? "sin datos"}`);
  }
  return data.id as string;
}

/** ¿Alguno de los efectos falló? Lo consulta el orquestador para loguear. */
export function huboFallas(resultados: readonly ResultadoEfecto[]): boolean {
  return resultados.some((r) => !r.ok);
}

/** Id del ticket creado en este turno, si hubo. */
export function idDeTicket(resultados: readonly ResultadoEfecto[]): string | null {
  return resultados.find((r) => r.efecto === "crear_ticket" && r.ok)?.id ?? null;
}
