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

/**
 * Las opciones del voto: ¿te sirvió la respuesta?
 *
 * Los emojis van en la ETIQUETA y no en el id, porque el id viaja en el
 * `callback_data` de Telegram —que tiene 64 bytes— y un emoji ocupa cuatro.
 * Además un id con emoji sería un dolor de cabeza para comparar.
 *
 * Dos opciones y no tres. Un «más o menos» en el medio se lleva la mayoría de
 * los votos y no dice nada: la pregunta que esto contesta es si hay que escribir
 * una respuesta mejor o no, y eso es binario.
 */
export const OPCIONES_VALORACION: readonly OpcionElegible[] = [
  { id: "voto_util", etiqueta: "👍 Sí, me sirvió" },
  { id: "voto_no_util", etiqueta: "👎 No me sirvió" },
];

export type Voto = "util" | "no_util";

/**
 * Los botones de voto, con el id del mensaje que se está valorando pegado.
 *
 * ESTO ES EL ARREGLO DE UN BUG QUE LLEGÓ A PRODUCCIÓN, y vale escribir por qué.
 *
 * Antes los ids eran fijos —`voto_util`— y era la BASE la que resolvía contra
 * qué mensaje iba el voto: buscaba el último saliente con `origen_respuesta` no
 * nulo. La idea era saltear el «¿te sirvió?», porque el comentario de la
 * migración afirmaba que `responderCon` sólo pone la traza en el primer saliente
 * del turno. Falso: le ponía `origenRespuesta` a TODOS, así que ningún saliente
 * tenía la columna en null y el «último no nulo» era siempre la propia pregunta
 * de cortesía. El 100% de los votos habría quedado colgado de ella.
 *
 * Y la inferencia fallaba de una segunda forma que ningún arreglo de esa
 * columna resolvía: Telegram deja los teclados viejos vivos para siempre, así
 * que un vecino puede tocar el pulgar veinte minutos después, cuando el último
 * saliente ya es una despedida o un paso de otro trámite. El voto se acreditaba
 * a ese.
 *
 * Ahora el botón lleva su referente: no hay nada que inferir, y un pulgar tocado
 * tarde sigue valorando la respuesta correcta. De paso arregla el doble toque —
 * mismo `mensaje_id` significa que el índice único hace su trabajo y el voto se
 * CORRIGE en vez de contarse dos veces e inflar el porcentaje.
 *
 * Sobre el largo: el `callback_data` de Telegram admite 64 bytes. «voto_no_util»
 * (12) + «:» (1) + un uuid (36) son 49. Entra. Los ids de botón de WhatsApp
 * admiten 256, así que también.
 */
export function opcionesDeVoto(mensajeId: string | null): readonly OpcionElegible[] {
  if (mensajeId === null) return OPCIONES_VALORACION;
  return OPCIONES_VALORACION.map((o) => ({ ...o, id: `${o.id}:${mensajeId}` }));
}

/**
 * Quita los modificadores de un emoji para poder compararlo.
 *
 * `👍🏽` no es `👍`: es `👍` más un modificador de tono de piel (U+1F3FB a
 * U+1F3FF). Y muchos teclados agregan un selector de variación (U+FE0F) que
 * tampoco se ve. Sin esto, un vecino que usa el pulgar con su tono de piel
 * —cosa habitual— manda un voto que no se registra, y el mensaje sigue de largo
 * hasta el clasificador: se paga una llamada al modelo y recibe un «no entendí»
 * por haber usado el mismo emoji que el bot le ofreció.
 */
function sinModificadores(texto: string): string {
  return texto.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}]/gu, "");
}

/** Un voto reconocido, con el mensaje al que corresponde si el botón lo traía. */
export interface VotoReconocido {
  readonly voto: Voto;
  /**
   * El saliente que se está valorando, o null si el botón no lo traía.
   *
   * Es null en dos casos legítimos: un botón de antes de este cambio, y un
   * vecino que manda el emoji suelto en vez de tocar. En los dos la base cae al
   * respaldo por conversación, que es peor pero es lo único que hay.
   */
  readonly mensajeId: string | null;
}

/**
 * ¿Este mensaje es un voto?
 *
 * A diferencia del menú, acá NO se aceptan números sueltos, y la razón es que
 * el bot no lleva registro de que acaba de ofrecer el voto. Un «2» suelto es
 * mucho más probable que sea una opción del menú principal —que el vecino ve
 * seguido— que un pulgar abajo. Leerlo como voto registraría una medición falsa
 * y, peor, no arrancaría el flujo que el vecino pidió.
 *
 * Es la misma decisión que ya se tomó en `resolverOpcion` cuando buscar palabras
 * sueltas hacía que «¿cuándo pasa el camión?» arrancara un reclamo: ante la
 * duda, no interpretar.
 *
 * Sí se acepta el emoji suelto, porque es inequívoco y hay gente que lo manda
 * en vez de tocar el botón.
 */
export function votoDe(entrante: {
  readonly seleccion?: string | null;
  readonly texto?: string | null;
}): VotoReconocido | null {
  // El toque de un botón es el camino normal, en Telegram y en WhatsApp. El id
  // puede venir con el mensaje pegado (`voto_util:<uuid>`) o sin él, si es un
  // teclado viejo de antes de que los botones llevaran su referente.
  const sel = entrante.seleccion ?? "";
  if (sel !== "") {
    const corte = sel.indexOf(":");
    const clave = corte === -1 ? sel : sel.slice(0, corte);
    const mensajeId = corte === -1 ? null : sel.slice(corte + 1) || null;
    if (clave === "voto_util") return { voto: "util", mensajeId };
    if (clave === "voto_no_util") return { voto: "no_util", mensajeId };
  }

  // El emoji suelto: inequívoco, y hay gente que lo manda en vez de tocar. Acá
  // no hay mensaje al que colgarlo, así que resuelve la base.
  const t = sinModificadores(normalizar(entrante.texto ?? ""));
  if (t === "") return null;

  const util = sinModificadores(normalizar(OPCIONES_VALORACION[0]!.etiqueta));
  const noUtil = sinModificadores(normalizar(OPCIONES_VALORACION[1]!.etiqueta));

  if (t === "👍" || t === util) return { voto: "util", mensajeId: null };
  if (t === "👎" || t === noUtil) return { voto: "no_util", mensajeId: null };

  return null;
}
