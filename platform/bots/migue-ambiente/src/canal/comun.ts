/**
 * Lo que los canales comparten y no es de ninguno.
 *
 * Vivía adentro de Telegram; se movió acá cuando llegó WhatsApp. Dos copias de
 * `partirTexto` o de la disculpa de error divergen solas — ya pasó con otras
 * listas duplicadas en este proyecto.
 */

/** El máximo de un mensaje de texto, casualmente igual en los dos canales. */
export const MAX_CARACTERES = 4096;

/**
 * Parte un texto largo en varios mensajes.
 *
 * Corta por párrafos y después por líneas, para no romper una oración al medio.
 * Es improbable que pase —las respuestas son breves a propósito— pero un
 * documento institucional citado extenso podría pasarse, y perder el envío por
 * eso sería una falla evitable.
 */
export function partirTexto(texto: string, maximo = MAX_CARACTERES): string[] {
  if (texto.length <= maximo) return [texto];

  const partes: string[] = [];
  let actual = "";

  for (const parrafo of texto.split("\n\n")) {
    const candidato = actual === "" ? parrafo : `${actual}\n\n${parrafo}`;

    if (candidato.length <= maximo) {
      actual = candidato;
      continue;
    }

    if (actual !== "") {
      partes.push(actual);
      actual = "";
    }

    // Un párrafo solo que ya excede el límite: se corta por líneas.
    if (parrafo.length <= maximo) {
      actual = parrafo;
      continue;
    }
    let resto = parrafo;
    while (resto.length > maximo) {
      const corte = resto.lastIndexOf("\n", maximo) > 0 ? resto.lastIndexOf("\n", maximo) : maximo;
      partes.push(resto.slice(0, corte));
      resto = resto.slice(corte).replace(/^\n/, "");
    }
    actual = resto;
  }

  if (actual !== "") partes.push(actual);
  return partes;
}

/**
 * Los DOS únicos textos al vecino clavados en código, y con motivo: corren
 * cuando atender el mensaje FALLÓ (o antes de procesarlo), y leer el catálogo
 * para redactarlos puede ser exactamente lo que acaba de fallar. Un mensaje de
 * error que también falla deja al vecino sin nada. El nombre del área está
 * verificado contra los Planes Rectores del municipio.
 */
export const DISCULPA_ERROR =
  "Tuve un problema para procesar tu mensaje. Probá de nuevo en un momento, " +
  "o escribí a la Secretaría de Ambiente y Desarrollo Sustentable si es urgente.";

export const AVISO_FRECUENCIA =
  "Estás enviando mensajes muy seguido. Esperá un momento y volvé a escribirme.";
