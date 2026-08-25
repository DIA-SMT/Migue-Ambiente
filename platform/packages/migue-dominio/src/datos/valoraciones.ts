/**
 * El voto del vecino sobre una respuesta.
 *
 * Las dos funciones van por RPC y no por insert directo porque las dos tienen
 * que resolver algo que el bot no sabe:
 *
 *   registrarVoto  contra QUÉ mensaje va el voto, CUANDO el botón no lo trae.
 *                  El camino normal es que sí lo traiga —los botones llevan el
 *                  id del saliente valorado— y entonces no hay nada que
 *                  resolver. El respaldo por conversación es para el emoji
 *                  suelto y para teclados viejos.
 *   comentarVoto   si el texto que acaba de llegar corresponde a un voto que
 *                  está esperando explicación, o es una consulta nueva.
 *
 * Las dos son idempotentes y no lanzan: un voto que no se puede registrar no
 * tiene que romperle la conversación al vecino. Se pierde la medición, que es
 * el menor de los dos males.
 */
import { obtenerCliente } from "./cliente.ts";
import type { SobreQue, Voto } from "../flujos/opciones.ts";

/**
 * Registra el voto sobre la última respuesta de la conversación.
 *
 * Devuelve el id del voto, o null si no había nada que valorar — que pasa si el
 * vecino toca un botón viejo de una conversación que ya se cerró.
 */
export async function registrarVoto(
  conversacionId: string,
  voto: Voto,
  mensajeId: string | null = null,
  sobre: SobreQue = "respuesta",
): Promise<string | null> {
  const { data, error } = await obtenerCliente().rpc("registrar_voto", {
    p_conversacion_id: conversacionId,
    p_voto: voto,
    // Explícito y no inferido del mensaje votado. Se podría deducir del
    // `origen_respuesta` —los pasos de un trámite son 'flujo'— pero este
    // proyecto ya se quemó confiando en esa columna para esto.
    p_sobre: sobre,
    // Cuando el botón trae el mensaje, la base NO infiere nada. El respaldo por
    // conversación sigue existiendo para el emoji suelto y para los teclados
    // viejos, pero es el camino excepcional y no el normal.
    p_mensaje_id: mensajeId,
  });

  // No se lanza a propósito. Si esto falla, el vecino ya tocó el botón y espera
  // una respuesta: mandarle un error porque no pudimos guardar una métrica
  // sería cambiar un problema nuestro por un problema suyo.
  if (error) return null;
  return (data as string | null) ?? null;
}

/**
 * Intenta pegar este texto como explicación del último voto negativo.
 *
 * La decisión de si corresponde la toma la base (ventana de tiempo, voto sin
 * comentario todavía). Acá se llama sin condiciones y se ignora el resultado
 * cuando es `false`: el texto era una consulta nueva y sigue su camino normal.
 */
export async function comentarVoto(
  conversacionId: string,
  comentario: string,
): Promise<boolean> {
  const { data, error } = await obtenerCliente().rpc("comentar_voto", {
    p_conversacion_id: conversacionId,
    p_comentario: comentario,
  });

  if (error) return false;
  return data === true;
}
