/**
 * La encuesta de cierre: a quién preguntarle y cómo no preguntar dos veces.
 *
 * Se pregunta UNA vez por conversación, cuando la charla lleva un rato en
 * silencio. El corte es por silencio y no por despedida porque la mayoría de
 * los vecinos no se despide: deja de contestar y listo.
 *
 * Las cuatro condiciones que decide quién la recibe viven en la función
 * `conversaciones_para_encuestar` de la base (migración 031), con el motivo de
 * cada una comentado ahí. Están en SQL y no acá porque son fáciles de olvidar y
 * porque el índice parcial que las hace baratas está al lado.
 */
import { obtenerCliente } from "./cliente.ts";

export interface ConversacionParaEncuestar {
  readonly id: string;
  readonly canal: string;
  readonly canalUsuarioId: string;
}

/**
 * Las conversaciones que se apagaron y merecen la pregunta.
 *
 * Con `minutos` en 0 devuelve vacío sin consultar: es el apagado desde el
 * panel, y hacer el viaje para descartar el resultado sería gastar una consulta
 * por barrido a cambio de nada.
 */
export async function conversacionesParaEncuestar(
  minutos: number,
  limite = 20,
): Promise<ConversacionParaEncuestar[]> {
  if (!(minutos > 0)) return [];

  const { data, error } = await obtenerCliente().rpc("conversaciones_para_encuestar", {
    p_minutos: Math.round(minutos),
    p_limite: limite,
  });
  if (error) throw error;

  return (data ?? []).map((f: Record<string, unknown>) => ({
    id: String(f["id"]),
    canal: String(f["canal"]),
    canalUsuarioId: String(f["canal_usuario_id"]),
  }));
}

/**
 * Marca la encuesta como enviada. Devuelve false si ya estaba marcada.
 *
 * Se llama ANTES de mandar el mensaje, no después, y el orden importa: es el
 * candado. Dos barridos simultáneos —o el mismo barrido corriendo mientras el
 * anterior no terminó— pueden llegar juntos a la misma conversación; el que
 * pierde recibe false y no manda nada. Al revés, marcando después del envío,
 * la ventana entre mandar y marcar alcanza para que el vecino reciba la
 * pregunta dos veces.
 *
 * El costo de este orden: si el envío falla después de marcar, esa conversación
 * se queda sin encuesta. Es el lado correcto para equivocarse — una encuesta
 * perdida no molesta a nadie, una duplicada sí.
 */
export async function marcarEncuestaEnviada(conversacionId: string): Promise<boolean> {
  const { data, error } = await obtenerCliente().rpc("marcar_encuesta_enviada", {
    p_conversacion: conversacionId,
  });
  if (error) throw error;
  return data === true;
}
