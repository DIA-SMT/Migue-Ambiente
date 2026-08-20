/**
 * Traduce el mensaje canónico al formato de envío de Telegram.
 *
 * Decisión que vale explicar: se envía en TEXTO PLANO, sin `parse_mode`.
 *
 * Telegram tiene tres modos de formato y cada uno escapa distinto. Con
 * MarkdownV2, un solo guion o paréntesis sin escapar hace fallar el envío
 * completo con un 400 — y nuestros textos vienen de dos lugares que no
 * controlamos: la tabla que edita el personal municipal y la redacción de un
 * modelo de lenguaje. Una dirección como «Lamadrid 50 (primera cuadra)» ya
 * rompe MarkdownV2.
 *
 * El costo es que no hay negritas. La ganancia es que ningún mensaje se pierde
 * por un carácter. Para un canal donde el vecino espera una respuesta, no
 * enviarla es mucho peor que enviarla sin negrita.
 */
import { InlineKeyboard } from "grammy";
import type { MensajeSaliente } from "@migue/dominio";

/** Límite de Telegram para un mensaje de texto. */
const MAX_CARACTERES = 4096;

/** Límite de Telegram para `callback_data`, en bytes. */
const MAX_CALLBACK_BYTES = 64;

export interface EnvioTelegram {
  readonly texto: string;
  readonly teclado: InlineKeyboard | undefined;
}

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
 * Arma el teclado en línea a partir de las opciones.
 *
 * Un botón por fila: las etiquetas de este bot son largas («Escombros /
 * material de construcción») y en un teléfono, dos por fila quedan cortadas.
 *
 * Una opción cuyo id no entra en `callback_data` se descarta en lugar de
 * hacer fallar el envío. No debería pasar —los ids son cortos— pero el costo
 * de que pase es que el vecino no recibe nada.
 */
export function armarTeclado(saliente: MensajeSaliente): InlineKeyboard | undefined {
  if (!saliente.opciones || saliente.opciones.length === 0) return undefined;

  // Se arman las filas explícitamente en vez de encadenar `.text().row()`:
  // llamar a `.row()` después del último botón deja una fila VACÍA al final del
  // teclado, que Telegram puede rechazar.
  const filas = saliente.opciones
    .filter((opcion) => Buffer.byteLength(opcion.id, "utf8") <= MAX_CALLBACK_BYTES)
    .map((opcion) => [{ text: opcion.etiqueta, callback_data: opcion.id }]);

  return filas.length > 0 ? InlineKeyboard.from(filas) : undefined;
}

/**
 * Convierte un saliente en uno o más envíos.
 *
 * El teclado va SÓLO en el último: si el texto se partió en tres mensajes, los
 * botones tienen que estar debajo del último para que queden junto a la
 * pregunta y no perdidos en el medio.
 */
export function renderizar(saliente: MensajeSaliente): EnvioTelegram[] {
  const partes = partirTexto(saliente.texto);
  const teclado = armarTeclado(saliente);

  return partes.map((texto, indice) => ({
    texto,
    teclado: indice === partes.length - 1 ? teclado : undefined,
  }));
}
