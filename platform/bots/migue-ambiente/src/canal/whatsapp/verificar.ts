/**
 * Las dos preguntas que hay que contestar antes de creerle a un pedido: ¿esto
 * lo manda Meta, o cualquiera que descubrió la URL?
 *
 * Todo acá es puro: entran bytes y un secreto, sale un booleano. Por eso se
 * puede probar entero sin levantar un servidor ni tener credenciales, que es
 * justo lo que necesitamos mientras el trámite con Meta va por su carril.
 *
 * SON DOS MOMENTOS DISTINTOS Y SE CONFUNDEN SEGUIDO:
 *
 *   Alta      Una sola vez, cuando se carga la URL en el panel de Meta. Meta
 *             pega un GET con `hub.verify_token` —una cadena que inventamos
 *             nosotros y escribimos en los dos lados— y espera que le
 *             devolvamos el `hub.challenge` tal cual.
 *
 *   Mensajes  Siempre. Meta pega un POST con la cabecera
 *             `X-Hub-Signature-256`, que es un HMAC del cuerpo hecho con el
 *             App Secret de la aplicación. El token del alta no interviene.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Meta manda la firma como `sha256=` seguido del hexadecimal en minúsculas. */
const PREFIJO = "sha256=";

/**
 * Compara sin filtrar por tiempo cuántos caracteres coincidían.
 *
 * `timingSafeEqual` EXPLOTA si los buffers miden distinto, así que el largo se
 * chequea antes. Eso deja escapar el largo, que no es secreto: lo que no puede
 * escapar es cuánto del contenido acertaste, porque con eso se adivina un
 * secreto de a un carácter por vez.
 */
function igualSinFiltrarTiempo(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * ¿La firma del POST corresponde a este cuerpo y a nuestro App Secret?
 *
 * El cuerpo entra como Buffer y NO como objeto a propósito. La firma se calcula
 * sobre los bytes tal como viajaron: si se interpreta el JSON y se vuelve a
 * serializar, alcanza un espacio de más o un `á` escrito distinto para que
 * el HMAC dé otra cosa y todos los mensajes se rechacen. Es el error clásico de
 * esta integración y no se ve hasta que llega el primer mensaje real.
 */
export function firmaValida(
  crudo: Buffer,
  recibida: string | undefined,
  secretoApp: string,
): boolean {
  if (secretoApp === "") return false;
  if (typeof recibida !== "string") return false;

  // Se normaliza porque el hexadecimal en mayúsculas es el mismo valor, y
  // rechazar por eso sería un rechazo por formato disfrazado de firma inválida.
  const limpia = recibida.trim().toLowerCase();
  if (!limpia.startsWith(PREFIJO)) return false;

  const esperada = PREFIJO + createHmac("sha256", secretoApp).update(crudo).digest("hex");
  return igualSinFiltrarTiempo(limpia, esperada);
}

/**
 * ¿Este GET es el alta del webhook? Devuelve qué contestar, o null si no.
 *
 * Devolver el `hub.challenge` es lo único que Meta mira: si no vuelve tal cual,
 * en texto plano y con 200, el webhook queda sin dar de alta y no llega ningún
 * mensaje. No hay reintento automático, hay que volver a apretar el botón.
 */
export function desafioDeAlta(
  consulta: URLSearchParams,
  tokenEsperado: string,
): string | null {
  if (tokenEsperado === "") return null;
  if (consulta.get("hub.mode") !== "subscribe") return null;

  const token = consulta.get("hub.verify_token");
  const desafio = consulta.get("hub.challenge");
  if (token === null || desafio === null) return null;

  return igualSinFiltrarTiempo(token, tokenEsperado) ? desafio : null;
}
