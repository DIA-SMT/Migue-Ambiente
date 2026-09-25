"use server";

/**
 * Leer una conversación completa.
 *
 * Es una acción de servidor y no una consulta desde el navegador porque la
 * transcripción es lo más sensible que muestra el panel: los mensajes de un
 * vecino, con su dirección y su teléfono si los dio. Que la traiga el servidor
 * bajo la sesión de quien está mirando, y sólo cuando alguien abre esa charla,
 * es una superficie más chica que exponerla como consulta del cliente.
 *
 * El RLS igual la protege —`transcripcion()` es `security invoker`— así que esto
 * es la segunda cerradura, no la única.
 */
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import type { MensajeTranscripto } from "@/lib/tipos";

export type ResultadoTranscripcion =
  | { ok: true; mensajes: MensajeTranscripto[] }
  | { ok: false; mensaje: string };

export async function leerTranscripcion(
  conversacionId: string,
): Promise<ResultadoTranscripcion> {
  const persona = await personaActual();
  if (!persona) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const supabase = await clienteServidor();
  const { data, error } = await supabase.rpc("transcripcion", {
    p_conversacion_id: conversacionId,
  });

  if (error) return { ok: false, mensaje: error.message };

  // Cero mensajes no es un error, pero tampoco es normal: una conversación
  // existe porque alguien escribió. Si llega vacía, casi seguro es RLS
  // filtrando, y decirlo es mejor que mostrar una charla en blanco.
  const mensajes = (data ?? []) as MensajeTranscripto[];
  if (mensajes.length === 0) {
    return {
      ok: false,
      mensaje: "No pude leer los mensajes de esta conversación. Puede ser un permiso.",
    };
  }

  return { ok: true, mensajes };
}
