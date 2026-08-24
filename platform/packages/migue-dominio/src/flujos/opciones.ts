/**
 * Relacionar lo que el vecino ESCRIBE con las opciones que se le ofrecieron.
 *
 * El problema, reportado al probar el bot: cuando Migue ofrece opciones y el
 * vecino contesta «1» en vez de tocar el botón, nadie relaciona ese «1» con la
 * primera opción. El paso no reconoce nada y repregunta, y el vecino repite el
 * número pensando que no llegó.
 *
 * Pasa por dos motivos y los dos son razonables del lado del vecino:
 *   · Mucha gente escribe en vez de tocar, por costumbre o porque el teclado ya
 *     está abierto.
 *   · El menú principal se envía como TEXTO numerado, así que no hay botón que
 *     tocar: escribir el número es la única forma.
 *
 * Y va a ser más común todavía en WhatsApp, donde los botones tienen límites
 * más duros que en Telegram.
 *
 * Todo acá es puro: entra un texto y una lista de opciones, sale un id o null.
 */

/** Una opción tal como se le ofrece al vecino. */
export interface OpcionElegible {
  readonly id: string;
  readonly etiqueta: string;
}

/** Quita acentos y baja a minúsculas, para comparar sin sorpresas. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Palabras que acompañan a un número cuando se está eligiendo una opción.
 *
 * Sirven para distinguir «opción 2» —que elige— de «2 bolsas» —que es una
 * cantidad—. Sin esta distinción, un vecino que escribe «3 bolsas de escombros»
 * en un paso con tres opciones estaría eligiendo la tercera sin querer.
 */
const ACOMPAÑAN_AL_NUMERO = [
  "opcion",
  "opciones",
  "la",
  "el",
  "numero",
  "nro",
  "punto",
  "eligo",
  "elijo",
  "quiero la",
  "quiero el",
  "dale la",
];

/**
 * ¿El texto es una referencia a una opción por su número?
 *
 * Devuelve el índice de base 1, o null. Acepta:
 *   «2»  «2.»  «2)»  «-2»  «opcion 2»  «la 2»  «numero 2»  «el 3»
 *
 * Y NO acepta:
 *   «2 bolsas»       es una cantidad
 *   «lamadrid 250»   es una dirección
 *   «25»             fuera de rango, no hay 25 opciones
 */
export function numeroDeOpcion(texto: string, cantidadDeOpciones: number): number | null {
  const norm = normalizar(texto)
    // Puntuación de lista que la gente escribe alrededor del número.
    .replace(/^[-*•.)\s]+/, "")
    .replace(/[.)\s]+$/, "")
    .trim();

  if (norm === "") return null;

  // Caso limpio: el mensaje ES el número.
  if (/^\d{1,2}$/.test(norm)) {
    const n = Number(norm);
    return n >= 1 && n <= cantidadDeOpciones ? n : null;
  }

  // Caso con acompañante: «opción 2», «la 3». Se exige que lo que precede al
  // número sea SÓLO una de esas palabras, y que después no venga nada más: eso
  // es lo que descarta «3 bolsas» y «entre 2 y 3 metros».
  const conAcompanante = /^([a-z ]{1,12}?)\s*(\d{1,2})$/.exec(norm);
  if (conAcompanante) {
    const prefijo = conAcompanante[1]!.trim();
    const n = Number(conAcompanante[2]);
    if (ACOMPAÑAN_AL_NUMERO.includes(prefijo) && n >= 1 && n <= cantidadDeOpciones) {
      return n;
    }
  }

  return null;
}

/**
 * Resuelve el texto del vecino a uno de los ids ofrecidos, SÓLO si el mensaje ES
 * la elección.
 *
 * Resuelve por número, por id exacto o por etiqueta exacta. Deliberadamente NO
 * busca una palabra suelta dentro de una frase, y las dos razones salieron de
 * romper tests:
 *
 *   · Los pasos leen la elección con `textoEfectivo()`, que devuelve
 *     `seleccion ?? texto`. Completar `seleccion` REEMPLAZA el texto, así que con
 *     «escombros, 3 bolsas» resolver la categoría por la palabra hacía perder el
 *     «3 bolsas» y el vecino tenía que repetir la cantidad.
 *
 *   · Buscar palabras sueltas es un clasificador, y peor que el que ya hay.
 *     «¿cuándo pasa el camión?» contiene «camión» y habría arrancado el flujo de
 *     RECLAMO, cuando es una consulta. El prompt del clasificador tiene esa regla
 *     escrita justamente porque distinguir las dos cosas importa: «¿cuándo pasa
 *     el camión?» es una pregunta, «el camión no pasó» es un reclamo.
 *
 * La regla, entonces: si el mensaje trae más que la elección, no se toca. Lo
 * interpreta quien sabe — el paso, o el clasificador.
 */
export function resolverOpcion(
  texto: string | null | undefined,
  opciones: readonly OpcionElegible[],
): string | null {
  if (!texto || opciones.length === 0) return null;

  const norm = normalizar(texto);
  if (norm === "") return null;

  const n = numeroDeOpcion(texto, opciones.length);
  if (n !== null) return opciones[n - 1]!.id;

  const exacta = opciones.find(
    (o) => normalizar(o.id) === norm || normalizar(o.etiqueta) === norm,
  );
  return exacta ? exacta.id : null;
}

/**
 * Las opciones del menú principal.
 *
 * Los ids SON intenciones que entiende el orquestador, y eso no es un detalle:
 * cuando el vecino elige del menú ya dijo qué quiere, así que no hace falta
 * llamar al clasificador para adivinarlo.
 *
 * Son SEIS y no cuatro. La spec planteaba cuatro ramas con un submenú para los
 * programas, pero los tres programas son flujos distintos —EDUCÁ, TRANSFORMÁ y
 * SEPARÁ capturan datos distintos— así que un submenú sería un paso más para
 * llegar al mismo lugar. Seis opciones se leen de un vistazo.
 *
 * Y hay un motivo más duro: la primera versión de este menú tenía una opción
 * «programas» que no correspondía a ningún flujo. Elegirla hacía que
 * `iniciarFlujo` recibiera undefined y el bot se caía. El test que debía
 * atraparlo comparaba los ids contra una lista escrita a mano en el propio
 * test, así que confirmaba mi suposición en vez de la realidad. Ahora se
 * comparan contra `NOMBRES_FLUJO`.
 *
 * Las etiquetas viven acá y no en `textos_bot` porque tienen que corresponderse
 * con estos ids: si alguien reordenara la lista desde el panel, los números que
 * ve el vecino dejarían de coincidir con las intenciones. El texto de
 * presentación SÍ es editable —es `menu_principal`— y es donde se ajusta el tono.
 */
export const OPCIONES_MENU: readonly OpcionElegible[] = [
  { id: "retiro_no_habitual", etiqueta: "Retirar escombros, poda o muebles" },
  { id: "reclamo_recoleccion", etiqueta: "El camión no pasó" },
  { id: "programa_separa", etiqueta: "Reciclables y SEPARÁ" },
  { id: "programa_educa", etiqueta: "Taller o charla para una institución (EDUCÁ)" },
  { id: "programa_transforma", etiqueta: "Mural o intervención en un espacio (TRANSFORMÁ)" },
  { id: "consulta_libre", etiqueta: "Otra consulta" },
];
