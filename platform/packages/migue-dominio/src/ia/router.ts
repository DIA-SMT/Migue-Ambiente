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
import { leerConfig, type Catalogo } from "../datos/catalogo.ts";
import { contienePalabra, normalizar, recortar } from "../texto.ts";
import type { NombreFlujo } from "../flujos/tipos.ts";

export type Intencion =
  | NombreFlujo
  | "consulta_libre"
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
 * Resuelve saludos y despedidas sin llamar al modelo.
 *
 * Sólo actúa si el mensaje es CORTO. «Hola, necesito que me retiren unos
 * escombros» es un pedido, no un saludo: contestarle «¡Hola!» y esperar sería
 * exactamente el comportamiento que el QA critica.
 */
function porAtajo(texto: string): Intencion | null {
  const norm = normalizar(texto);
  if (norm === "") return null;

  const palabras = norm.split(" ").length;
  if (palabras > 4) return null;

  for (const s of DESPEDIDAS) {
    if (norm === normalizar(s) || contienePalabra(norm, s)) return "despedida";
  }
  for (const s of SALUDOS) {
    if (norm === normalizar(s) || contienePalabra(norm, s)) return "saludo";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Clasificación por IA
// ---------------------------------------------------------------------------

interface SalidaRouter {
  readonly intencion?: string;
  readonly confianza?: number;
}

function instrucciones(): string {
  return [
    "Clasificás el mensaje de un vecino que le escribe al bot de la Dirección de",
    "Ambiente de San Miguel de Tucumán. Devolvés SOLO JSON:",
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
    "consulta_libre       cualquier otra pregunta sobre temas ambientales: horarios,",
    "                     Puntos Verdes, qué se puede reciclar, programas, normativa.",
    "saludo               sólo saluda, sin pedir nada.",
    "despedida            agradece o se despide.",
    "no_entendido         el mensaje no se entiende, o no tiene nada que ver con",
    "                     ambiente ni con el municipio.",
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
        { role: "system", content: instrucciones() },
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
