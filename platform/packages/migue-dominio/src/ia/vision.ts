/**
 * Verificación de fotos con un modelo de visión.
 *
 * Mira la foto que mandó el vecino y dice si muestra residuos que el área
 * pueda gestionar, de qué categoría son, y una frase de qué se ve. El flujo
 * usa eso para repreguntar una vez si la foto claramente no corresponde, y el
 * ticket lo guarda para que el panel lo muestre junto a la foto.
 *
 * Dos reglas que no se negocian:
 *
 *   1. NUNCA bloquea. Cualquier fallo —timeout, JSON roto, modelo apagado,
 *      imagen gigante— devuelve `no_evaluada` y el trámite sigue como si la
 *      visión no existiera.
 *   2. NUNCA miente «valida». El bot que tenía el área aprobaba cualquier foto
 *      cuando su modelo se caía; acá el fallo se registra como lo que es.
 *
 * La taxonomía y los criterios de desambiguación vienen del relevamiento del
 * bot propio de Ambiente: los escribió gente que clasifica esto todos los días.
 */
import { chat, parsearJson, type MensajeChat } from "./cliente.ts";
import { leerConfig, type Catalogo } from "../datos/catalogo.ts";
import { recortar } from "../texto.ts";
import type { CategoriaFoto, EstadoVeredicto, VeredictoFoto } from "../mensajeria.ts";

export const VEREDICTO_NO_EVALUADO: VeredictoFoto = {
  veredicto: "no_evaluada",
  categoria: null,
  detalle: null,
};

export interface ImagenParaEvaluar {
  readonly datos: Uint8Array;
  readonly mime: string;
}

export interface ContextoVision {
  readonly flujo: "retiro_no_habitual" | "reclamo_recoleccion";
}

/**
 * Techo de tamaño. Una foto comprimida de Telegram pesa 100-500 KB; algo por
 * encima de esto es un documento sin comprimir, y el base64 lo infla un 33%
 * más. Antes que armar un cuerpo de 12 MB, se deja sin evaluar.
 */
const MAX_BYTES = 8 * 1024 * 1024;

const CATEGORIAS: readonly CategoriaFoto[] = [
  "basural",
  "volcadero",
  "rnh",
  "barrido",
  "limpieza_cestos",
  "otros",
];

/** Exportada para poder probar el contenido del prompt sin red. */
export function instruccionesDeVision(contexto: ContextoVision): string {
  const tramite =
    contexto.flujo === "retiro_no_habitual"
      ? "una solicitud de retiro de residuos no habituales"
      : "un reclamo por falta de recolección";

  return [
    "Sos el verificador de fotos del bot de la Secretaría de Ambiente de la",
    "Municipalidad de San Miguel de Tucumán. Un vecino mandó UNA foto dentro de",
    `${tramite}. Decís si la foto muestra residuos que el área pueda gestionar`,
    "y de qué categoría son. Devolvés SOLO JSON:",
    '{"veredicto": "valida"|"dudosa"|"no_corresponde", "categoria": "basural"|"volcadero"|"rnh"|"barrido"|"limpieza_cestos"|"otros"|null, "detalle": "..."}',
    "",
    "Categorías (elegí la que MEJOR describe lo que se ve):",
    "",
    "basural         bolsas de residuos domiciliarios ACUMULADAS, claramente de",
    "                varias casas, en la vía pública o un terreno.",
    "volcadero       escombros o materiales masivos (tierra, cascotes, restos de",
    "                obra, chatarra grande) tirados en un espacio abierto, SIN",
    "                bolsas domiciliarias.",
    "rnh             retiro no habitual: POCOS ítems de UNA sola casa, frente a",
    "                una vivienda. Escombros embolsados, ramas de poda, un",
    "                mueble, un colchón, un electrodoméstico.",
    "barrido         suciedad DISPERSA sobre calle o vereda: hojas, tierra,",
    "                papeles sueltos. No hay volumen para retirar; hay que barrer.",
    "limpieza_cestos cesto público o contenedor DESBORDADO, con residuos alrededor.",
    "otros           se ven residuos pero no encajan en ninguna de las anteriores.",
    "",
    "Cómo desambiguar:",
    "- La ESCALA separa rnh de basural/volcadero: pocos ítems frente a una",
    "  vivienda es rnh; una acumulación de varias fuentes es basural (si domina",
    "  la bolsa domiciliaria) o volcadero (si es material masivo sin bolsas).",
    "- Suciedad sin volumen es barrido, no basural.",
    "",
    "Veredicto:",
    '- "valida": se ven residuos con claridad.',
    '- "dudosa": parece haber residuos pero la foto no alcanza para asegurarlo',
    "  (oscura, lejana, borrosa, encuadre parcial).",
    '- "no_corresponde": la foto NO muestra residuos: una persona, un documento,',
    "  una captura de pantalla, un paisaje, un interior sin residuos.",
    "",
    "Reglas:",
    "- detalle: UNA frase corta en español rioplatense que describa qué se ve.",
    "  La lee el equipo del área, y si el veredicto es no_corresponde también se",
    "  le muestra al vecino para pedirle otra foto — escribila para eso,",
    "  empezando en minúscula (va dentro de otra oración). Obligatoria siempre.",
    "- categoria va en null sólo si el veredicto es no_corresponde.",
    '- Ante la duda, "dudosa". No inventes lo que no se distingue.',
  ].join("\n");
}

/**
 * Interpreta la salida del modelo. Exportada para probar sin red. NUNCA lanza:
 * cualquier cosa que no cumpla el contrato degrada a `no_evaluada` — un modelo
 * que contesta mal es indistinguible de uno que no contesta.
 */
export function parsearVeredicto(texto: string): VeredictoFoto {
  const crudo = parsearJson<{
    veredicto?: string;
    categoria?: string | null;
    detalle?: string | null;
  }>(texto);
  if (crudo === null) return VEREDICTO_NO_EVALUADO;

  const veredicto = crudo.veredicto?.trim();
  // `no_evaluada` no se acepta del modelo: es NUESTRO estado de fallo, no una
  // opinión que el modelo pueda emitir.
  if (veredicto !== "valida" && veredicto !== "dudosa" && veredicto !== "no_corresponde") {
    return VEREDICTO_NO_EVALUADO;
  }

  const categoria = CATEGORIAS.includes(crudo.categoria as CategoriaFoto)
    ? (crudo.categoria as CategoriaFoto)
    : null;
  const detalle =
    typeof crudo.detalle === "string" && crudo.detalle.trim() !== ""
      ? recortar(crudo.detalle.trim(), 300)
      : null;

  return { veredicto: veredicto as EstadoVeredicto, categoria, detalle };
}

/**
 * Evalúa la foto con el modelo configurado en `modelo_vision`.
 *
 * `llamar` se inyecta para las pruebas; en producción es `chat`. Con la clave
 * vacía en el panel devuelve `no_evaluada` sin llamar a nada: es el
 * interruptor para apagar la visión sin deploy.
 */
export async function evaluarFoto(
  imagen: ImagenParaEvaluar,
  contexto: ContextoVision,
  catalogo: Catalogo,
  llamar: typeof chat = chat,
): Promise<VeredictoFoto> {
  const modelo = String(
    leerConfig(catalogo, "modelo_vision", "anthropic/claude-haiku-4.5"),
  ).trim();
  if (modelo === "") return VEREDICTO_NO_EVALUADO;
  if (imagen.datos.length === 0 || imagen.datos.length > MAX_BYTES) {
    return VEREDICTO_NO_EVALUADO;
  }

  const mensajes: MensajeChat[] = [
    { role: "system", content: instruccionesDeVision(contexto) },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: `data:${imagen.mime};base64,${Buffer.from(imagen.datos).toString("base64")}`,
          },
        },
        { type: "text", text: "Evaluá esta foto según las instrucciones." },
      ],
    },
  ];

  try {
    const r = await llamar({
      modelo,
      mensajes,
      maxTokens: 200,
      temperatura: 0,
      json: true,
      // Hay un vecino esperando en el chat y el fallback es inocuo: un timeout
      // corto sin reintentos le gana a una respuesta perfecta que llega tarde.
      timeoutMs: 12_000,
      reintentos: 0,
    });
    return parsearVeredicto(r.texto);
  } catch {
    return VEREDICTO_NO_EVALUADO;
  }
}
