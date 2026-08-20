/**
 * Normalización de texto del vecino.
 *
 * Tiene que coincidir con lo que hace la configuración de búsqueda
 * `es_sin_acentos` en Postgres (unaccent + minúsculas). Si las dos puntas
 * normalizan distinto, una regla que coincide en el motor no coincide en la
 * búsqueda y el bot se comporta de forma inconsistente sin razón visible.
 */

/**
 * Pasa a minúsculas, quita diacríticos y colapsa todo lo que no sea letra o
 * número a un espacio simple.
 *
 * La ñ se convierte en n, igual que hace `unaccent` en Postgres. Se pierde la
 * distinción, pero la ganancia es mayor: el vecino escribe "muñecas" y
 * "munecas" indistintamente.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    // \p{M} = toda marca combinante. Preferido a un rango literal de
    // caracteres, que es invisible en el diff y fácil de romper al editar.
    .replace(/\p{M}+/gu, "")
    // Los superíndices son categoría Number en Unicode, así que sobreviven al
    // filtro de abajo y "m³" quedaría distinto de "m3". Para el parseo de
    // volumen tienen que ser el mismo texto.
    .replace(/³/g, "3")
    .replace(/²/g, "2")
    .toLowerCase()
    // Barre la puntuación a espacios, PERO conserva un punto o coma que esté
    // entre dígitos. Sin esta excepción, "0,2 m3" se parte en los tokens "0" y
    // "2" y el parser de cantidades lo lee como el rango 0 a 2.
    .replace(/[^\p{L}\p{N}]+/gu, (coincidencia, posicion: number, completo: string) => {
      const esSeparadorDecimal =
        coincidencia.length === 1 &&
        (coincidencia === "." || coincidencia === ",") &&
        /\d/.test(completo[posicion - 1] ?? "") &&
        /\d/.test(completo[posicion + 1] ?? "");
      return esSeparadorDecimal ? "." : " ";
    })
    .trim();
}

/**
 * Escapa un texto para usarlo dentro de una expresión regular.
 * Necesario porque las palabras de las reglas las carga un operador desde el
 * panel: un paréntesis suelto en "SAT (agua)" rompería la regex.
 */
export function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ¿Aparece `termino` en `texto` como palabra completa?
 *
 * Esto es lo que evita el error más peligroso del motor de exclusiones. La
 * regla de gas tiene la palabra "gas", y con coincidencia por substring
 * "cuánto gasto en bolsas" derivaría al vecino a Naturgy. Con límite de
 * palabra, "gas" no coincide con "gasto", "gaseosa" ni "pagas".
 *
 * Acepta el plural español agregando `s` o `es`, para que la regla "pila"
 * también agarre "pilas" sin tener que cargar cada forma a mano.
 *
 * Funciona igual con frases de varias palabras ("olor a gas"): se pluraliza
 * sólo el final, que es lo que corresponde.
 */
export function contienePalabra(texto: string, termino: string): boolean {
  const textoNorm = normalizar(texto);
  const terminoNorm = normalizar(termino);
  if (terminoNorm === "") return false;

  // Lookarounds en vez de \b: \b es ASCII y no queremos depender de que la
  // normalización haya dejado solamente ASCII.
  const patron = new RegExp(
    `(?<![\\p{L}\\p{N}])${escaparRegex(terminoNorm)}(es|s)?(?![\\p{L}\\p{N}])`,
    "u",
  );
  return patron.test(textoNorm);
}

/**
 * Devuelve el primer término de la lista que aparece en el texto, o null.
 * Respeta el orden recibido, así el llamador decide la precedencia.
 */
export function primerTerminoPresente(
  texto: string,
  terminos: readonly string[],
): string | null {
  const textoNorm = normalizar(texto);
  for (const termino of terminos) {
    if (contienePalabra(textoNorm, termino)) return termino;
  }
  return null;
}

/** Corta un texto para loguearlo sin llenar la base de ruido. */
export function recortar(texto: string, maximo = 280): string {
  const limpio = texto.trim();
  return limpio.length <= maximo ? limpio : `${limpio.slice(0, maximo - 1)}…`;
}
