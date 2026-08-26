/**
 * Router de intención: decide qué hace el bot con un mensaje.
 *
 * Es la pieza que implementa la crítica central del documento de QA. El bot
 * anterior imponía un menú de opciones antes de escuchar, y el vecino tenía que
 * navegarlo aunque ya hubiera dicho lo que quería. Acá el menú es el ÚLTIMO
 * recurso: sólo aparece cuando de verdad no se entendió el mensaje.
 *
 * Orden de resolución, de más barato a más caro:
 *
 *   1. Atajo por palabras     saludos y despedidas, sin llamar a ningún modelo
 *   2. Clasificación por IA   el resto
 *   3. Menú                   sólo si la confianza no alcanza
 *
 * El atajo importa por costo real: «hola» es el mensaje más frecuente de
 * cualquier bot, y resolverlo con una llamada a un modelo es pagar por algo
 * que una lista de veinte palabras resuelve igual.
 */
import { chat, parsearJson } from "./cliente.ts";
import { leerConfig, nombreDelArea, type Catalogo } from "../datos/catalogo.ts";
import { contienePalabra, normalizar, recortar } from "../texto.ts";
import type { NombreFlujo } from "../flujos/tipos.ts";

export type Intencion =
  | NombreFlujo
  | "consulta_libre"
  | "fuera_de_alcance"
  | "saludo"
  | "despedida"
  | "no_entendido";

export interface Clasificacion {
  readonly intencion: Intencion;
  readonly confianza: number;
  /** true si se resolvió sin llamar a ningún modelo. */
  readonly porAtajo: boolean;
  readonly modelo: string | null;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
  readonly costoUsd: number | null;
  readonly latenciaMs: number;
}

/** Los flujos a los que el router puede derivar. */
const FLUJOS: readonly NombreFlujo[] = [
  "retiro_no_habitual",
  "reclamo_recoleccion",
  "programa_educa",
  "programa_transforma",
  "programa_separa",
];

const INTENCIONES: readonly Intencion[] = [
  ...FLUJOS,
  "consulta_libre",
  "fuera_de_alcance",
  "saludo",
  "despedida",
  "no_entendido",
];

// ---------------------------------------------------------------------------
// Atajos sin modelo
// ---------------------------------------------------------------------------

const SALUDOS = [
  "hola", "holaa", "buenas", "buen dia", "buenos dias", "buenas tardes",
  "buenas noches", "que tal", "hey", "hi", "buenass", "holis",
];

const DESPEDIDAS = [
  "gracias", "muchas gracias", "gracias!", "listo gracias", "chau", "adios",
  "hasta luego", "nos vemos", "perfecto gracias", "ok gracias", "dale gracias",
  "muy amable", "barbaro",
];

/**
 * Palabras que pueden acompañar un saludo sin volverlo una consulta.
 *
 * «listo gracias», «ok gracias», «muy amable», «buenas, che» siguen siendo
 * despedidas. Sin esta lista, cualquier palabra sobrante haría que el atajo se
 * salteara y un simple «listo gracias» pagaría una llamada al modelo.
 */
const RELLENO = new Set([
  "ok", "oka", "okey", "listo", "dale", "che", "bueno", "buenisimo", "barbaro",
  "genial", "perfecto", "muy", "mil", "muchas", "muchisimas", "amable", "y",
  "eh", "ah", "a", "de", "nada", "todo", "bien", "si", "no", "gracias",
]);

/**
 * Resuelve saludos y despedidas sin llamar al modelo.
 *
 * Sólo actúa si el mensaje NO TRAE NADA MÁS que el saludo. Es la parte que
 * estaba mal, y el propio comentario de esta función ya decía qué tenía que
 * pasar: «Hola, necesito que me retiren unos escombros» es un pedido, no un
 * saludo. La guarda anterior era «como máximo 4 palabras», y no alcanzaba —
 * verificado corriendo el clasificador real:
 *
 *   «hola necesito retirar escombros»  ->  saludo      (son exactamente 4)
 *   «hola pasa el sabado?»             ->  saludo
 *   «gracias donde reciclo vidrio»     ->  despedida
 *
 * Los tres son consultas reales. Al vecino que preguntó por el vidrio Migue le
 * contestaba «¡De nada!» y le CERRABA la conversación. Y no quedaba registro en
 * ninguna parte: el atajo corta antes del modelo y antes de la búsqueda de
 * conocimiento, que es la única que sabe registrar una pregunta sin responder.
 * O sea que la falla era invisible por diseño.
 *
 * Ahora se quita del texto el término que coincidió y se mira lo que sobra: si
 * queda una sola palabra con contenido, el mensaje sigue su camino al modelo. El
 * costo de equivocarse en cada dirección no es simétrico —una llamada al modelo
 * de más cuesta una fracción de centavo; una pregunta contestada con «¡De nada!»
 * pierde a un vecino— así que ante la duda, no atajar.
 */
/**
 * Se exporta para poder probarla directo.
 *
 * `clasificar` toma el cliente del modelo a nivel de módulo, no inyectado, así
 * que una prueba que la use para los casos negativos dependería de la red. Y la
 * primera versión de esa prueba le pasaba un espía como tercer argumento que la
 * función NO recibe: los tests pasaban en verde sin observar nada. Probar
 * `porAtajo` directo es lo único que mide de verdad lo que se arregló.
 */
export function porAtajo(texto: string): Intencion | null {
  const norm = normalizar(texto);
  if (norm === "") return null;

  // `/start` es el primer mensaje de TODO vecino nuevo de Telegram: el botón
  // «Empezar» lo manda solo. No estaba manejado en ninguna parte, así que el
  // primer contacto de cada persona era «no entendí, elegí una opción» — y
  // encima pagaba una llamada al modelo para no entender un comando fijo.
  //
  // Se resuelve acá y no en el adaptador de Telegram porque un comando con barra
  // es una convención de canal, sí, pero la RESPUESTA correcta es la misma en
  // todos: es alguien abriendo la conversación. WhatsApp no manda `/start`, así
  // que allá esta rama simplemente no se usa.
  if (norm === "start" || norm.startsWith("start ")) return "saludo";

  // Un tope generoso, sólo para no gastar trabajo en un mensaje largo: si tiene
  // más de ocho palabras no es un saludo por más que empiece con «hola».
  if (norm.split(" ").length > 8) return null;

  // Los más largos primero: «listo gracias» tiene que ganarle a «gracias», para
  // que lo que sobra sea vacío y no «listo».
  const porLargo = (a: string, b: string) => normalizar(b).length - normalizar(a).length;

  for (const [lista, intencion] of [
    [[...DESPEDIDAS].sort(porLargo), "despedida"],
    [[...SALUDOS].sort(porLargo), "saludo"],
  ] as const) {
    for (const termino of lista) {
      const t = normalizar(termino);
      if (t === "") continue;
      if (norm !== t && !contienePalabra(norm, termino)) continue;

      // Lo que queda después de sacar TODA la cortesía, no sólo el término que
      // coincidió. «hola gracias» es alguien siendo amable, no una consulta: si
      // sólo se quitara «gracias», sobraría «hola» y el mensaje pagaría una
      // llamada al modelo para nada.
      if (soloCortesia(norm)) return intencion;
      // Coincidió pero traía algo más: que lo vea el modelo.
      return null;
    }
  }
  return null;
}

/**
 * ¿El texto está hecho SÓLO de cortesía?
 *
 * Se quitan todos los términos de las dos listas, del más largo al más corto
 * —«buenas tardes» antes que «buenas», «listo gracias» antes que «gracias»— y
 * después el relleno. Si no queda nada, era un saludo o una despedida y nada
 * más.
 */
function soloCortesia(norm: string): boolean {
  const terminos = [...SALUDOS, ...DESPEDIDAS]
    .map(normalizar)
    .filter((t) => t !== "")
    .sort((a, b) => b.length - a.length);

  let resto = norm;
  for (const t of terminos) {
    resto = resto.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${escaparParaAtajo(t)}(?![\\p{L}\\p{N}])`,
        "gu",
      ),
      " ",
    );
  }

  return resto
    .split(" ")
    .map((w) => w.trim())
    .every((w) => w === "" || RELLENO.has(w));
}

/** Escapa un término para poder buscarlo como palabra completa. */
function escaparParaAtajo(termino: string): string {
  return termino.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Clasificación por IA
// ---------------------------------------------------------------------------

interface SalidaRouter {
  readonly intencion?: string;
  readonly confianza?: number;
}

function instrucciones(catalogo: Catalogo): string {
  // Mismo nombre de área que usa la respuesta: si el clasificador y el que
  // contesta dijeran áreas distintas, el modelo recibiría dos identidades.
  const area = nombreDelArea(catalogo);
  return [
    `Clasificás el mensaje de un vecino que le escribe al bot de la ${area}`,
    "de la Municipalidad de San Miguel de Tucumán. Devolvés SOLO JSON:",
    '{"intencion": "...", "confianza": 0.0-1.0}',
    "",
    "Intenciones posibles:",
    "",
    "retiro_no_habitual   pide que le retiren escombros, poda, ramas, muebles,",
    "                     electrodomésticos o chatarra de su domicilio.",
    "reclamo_recoleccion  el camión de basura no pasó, o pasó y no llevó su bolsa.",
    "programa_educa       pide un taller, una charla o una visita para una",
    "                     institución educativa.",
    "programa_transforma  pide un mural, un cartel o una intervención en un espacio.",
    "programa_separa      pregunta por la recolección de reciclables en su domicilio,",
    "                     o quiere coordinar la entrega de reciclables.",
    "consulta_libre       cualquier otra pregunta sobre temas de Ambiente: horarios,",
    "                     Puntos Verdes, qué se puede reciclar, programas, normativa,",
    "                     residuos, arbolado, limpieza.",
    "fuera_de_alcance     se entiende PERFECTAMENTE lo que pide, y NO es de la",
    "                     Secretaría de Ambiente. Habilitaciones comerciales,",
    "                     impuestos y tasas, licencias de conducir, multas, obras",
    "                     particulares, bacheo, tránsito, alumbrado, agua, gas,",
    "                     salud, catastro, becas. También cualquier tema que no",
    "                     sea del municipio.",
    "saludo               sólo saluda, sin pedir nada.",
    "despedida            agradece o se despide.",
    "no_entendido         NO SE ENTIENDE qué quiere. Un mensaje sin sentido, un",
    "                     fragmento suelto, un audio transcripto mal. Esto NO es",
    "                     para lo que no es de Ambiente: eso es fuera_de_alcance.",
    "",
    "Reglas importantes:",
    "",
    "- Si el vecino PREGUNTA algo (dónde, cuándo, cómo, cuánto) es consulta_libre,",
    "  aunque el tema coincida con un flujo. «¿Cuándo pasa el camión?» es una",
    "  consulta; «el camión no pasó» es un reclamo.",
    "- Si el vecino NOMBRA el trámite en vez de describir el problema, también",
    "  cuenta, y con confianza alta. «Quiero hacer un reclamo», «quiero",
    "  denunciar», «vengo a reportar algo» son reclamo_recoleccion: es el único",
    "  reclamo que este bot gestiona, y el flujo le va a preguntar qué pasó.",
    "  «Quiero pedir un retiro», «necesito un camión», «quiero sacar unos",
    "  escombros» son retiro_no_habitual. No hace falta que describa el síntoma",
    "  para que se entienda qué quiere.",
    "- LA DISTINCIÓN MÁS IMPORTANTE: `no_entendido` es «no sé qué me pediste».",
    "  `fuera_de_alcance` es «sé perfectamente qué me pediste y no es mío». Con la",
    "  primera el bot muestra las opciones de Ambiente; con la segunda lo manda al",
    "  asistente general del municipio, que sí lo puede ayudar. Confundirlas hace",
    "  que alguien con un pedido claro reciba un menú que no le sirve.",
    "  «Necesito una habilitación comercial» es fuera_de_alcance con confianza",
    "  ALTA: está clarísimo, y no es de Ambiente. «asdfgh» es no_entendido.",
    "- Si además de saludar pide algo, clasificá el pedido y no el saludo.",
    "- La confianza refleja cuán claro está el mensaje, no cuán probable te parece",
    "  la intención. Un mensaje ambiguo lleva confianza baja aunque tengas una",
    "  corazonada: con confianza baja el bot pregunta en vez de adivinar, y",
    "  equivocarse de flujo le cuesta al vecino varias preguntas inútiles.",
  ].join("\n");
}

/**
 * Clasifica el mensaje.
 *
 * Nunca lanza: ante cualquier fallo devuelve `consulta_libre` con confianza 0.
 * Eso hace que un problema del router degrade a la cadena de conocimiento —que
 * ya sabe admitir que no sabe— en lugar de dejar al vecino sin respuesta.
 */
export async function clasificar(
  texto: string,
  catalogo: Catalogo,
): Promise<Clasificacion> {
  const base = {
    porAtajo: false,
    modelo: null,
    tokensEntrada: 0,
    tokensSalida: 0,
    costoUsd: null,
    latenciaMs: 0,
  } as const;

  const atajo = porAtajo(texto);
  if (atajo !== null) {
    return { ...base, intencion: atajo, confianza: 1, porAtajo: true };
  }

  const modelo = leerConfig(catalogo, "modelo_router", "openai/gpt-4o-mini");

  try {
    const r = await chat({
      modelo,
      maxTokens: 80,
      temperatura: 0,
      // Más corto que la síntesis: si el router demora, todo lo demás se
      // retrasa detrás de él.
      timeoutMs: 12_000,
      json: true,
      mensajes: [
        { role: "system", content: instrucciones(catalogo) },
        { role: "user", content: recortar(texto, 800) },
      ],
    });

    const salida = parsearJson<SalidaRouter>(r.texto);
    const cruda = salida?.intencion?.trim();

    // Una intención que no está en la lista es una alucinación del modelo. Se
    // trata como consulta libre en vez de intentar interpretarla.
    const intencion = INTENCIONES.includes(cruda as Intencion)
      ? (cruda as Intencion)
      : "consulta_libre";

    const confianza =
      typeof salida?.confianza === "number" && salida.confianza >= 0 && salida.confianza <= 1
        ? salida.confianza
        : 0;

    return {
      intencion,
      confianza: cruda === intencion ? confianza : 0,
      porAtajo: false,
      modelo: r.modelo,
      tokensEntrada: r.tokensEntrada,
      tokensSalida: r.tokensSalida,
      costoUsd: r.costoUsd,
      latenciaMs: r.latenciaMs,
    };
  } catch {
    // Timeout, cuota agotada o red caída. Degrada a la cadena de conocimiento.
    return { ...base, intencion: "consulta_libre", confianza: 0 };
  }
}

// ---------------------------------------------------------------------------
// Qué hacer con la clasificación
// ---------------------------------------------------------------------------

export type Decision =
  | { readonly tipo: "iniciar_flujo"; readonly flujo: NombreFlujo }
  | { readonly tipo: "consultar_conocimiento" }
  | { readonly tipo: "saludar" }
  | { readonly tipo: "despedir" }
  | { readonly tipo: "derivar" }
  | { readonly tipo: "mostrar_menu" };

/**
 * Traduce la clasificación en una acción.
 *
 * El umbral es lo que decide entre arrancar un flujo y preguntar. Equivocarse
 * de flujo le cuesta al vecino tres o cuatro preguntas inútiles antes de poder
 * corregir; mostrar el menú le cuesta una elección. Así que con poca confianza
 * se pregunta.
 *
 * Excepción deliberada: `consulta_libre` con confianza baja NO va al menú, va a
 * la cadena de conocimiento. Es la regla de «responder antes de preguntar»: la
 * cadena ya sabe admitir cuando no encuentra material, y es mejor intentar
 * responder y fallar que devolverle un menú a quien hizo una pregunta concreta.
 *
 * Y `fuera_de_alcance` con confianza alta deriva DIRECTO, sin pasar por el menú.
 * La diferencia con `no_entendido` es la que motivó separar las dos intenciones:
 * antes «necesito una habilitación comercial» caía en la misma etiqueta que
 * «asdfgh», y el modelo daba 0.2 o 0.95 para la MISMA frase según cómo estuviera
 * escrita — porque dudaba entre «no es de ambiente» (no_entendido) y «es del
 * municipio» (consulta_libre). Medido en producción con esas dos versiones.
 */
export function decidir(
  clasificacion: Clasificacion,
  catalogo: Catalogo,
): Decision {
  const umbral = Number(leerConfig(catalogo, "umbral_confianza_router", 0.6));
  const responderPrimero = leerConfig(catalogo, "responder_antes_de_preguntar", true) === true;

  switch (clasificacion.intencion) {
    case "saludo":
      return { tipo: "saludar" };

    case "despedida":
      return { tipo: "despedir" };

    case "no_entendido":
      return { tipo: "mostrar_menu" };

    case "fuera_de_alcance":
      // Se entendió qué pide y no es de Ambiente. Con confianza ALTA se deriva
      // de una: hacerle elegir entre opciones que ninguna le sirve es hacerlo
      // perder tiempo.
      //
      // Con confianza baja NO. El área pidió que el menú actúe de red contra
      // NUESTROS errores de clasificación, y la confianza es exactamente la
      // medida de eso: si el modelo duda, puede ser un pedido de Ambiente mal
      // leído, y derivarlo sería echar a un vecino por una falla propia.
      //
      // Y si no hay enlace cargado, `derivarAMigue` devuelve null y el
      // orquestador cae al menú igual.
      return clasificacion.confianza >= umbral
        ? { tipo: "derivar" }
        : { tipo: "mostrar_menu" };

    case "consulta_libre":
      return responderPrimero
        ? { tipo: "consultar_conocimiento" }
        : { tipo: "mostrar_menu" };

    default: {
      // Es un flujo. Sólo se arranca con confianza suficiente.
      if (clasificacion.confianza >= umbral) {
        return { tipo: "iniciar_flujo", flujo: clasificacion.intencion };
      }
      // Con poca confianza se intenta responder antes de imponer el menú: la
      // consulta puede tener respuesta en el corpus.
      return responderPrimero
        ? { tipo: "consultar_conocimiento" }
        : { tipo: "mostrar_menu" };
    }
  }
}

/** Los flujos válidos, para que el orquestador los registre. */
export { FLUJOS as flujosDelRouter };
