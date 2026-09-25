/**
 * Contrato de mensajes canónico.
 *
 * Es la frontera que hace que el núcleo no sepa qué canal lo invocó. Un
 * adaptador traduce del formato de su canal a estos tipos, y de estos tipos al
 * formato de su canal. Nada más abajo de esta capa menciona Telegram.
 *
 * Es lo que va a permitir sumar WhatsApp escribiendo un adaptador nuevo, sin
 * tocar reglas ni flujos.
 */

export type Canal = "telegram" | "whatsapp" | "web";

export type TipoMedia = "imagen" | "audio" | "video" | "documento" | "ubicacion";

// ---------------------------------------------------------------------------
// Veredicto de foto
// ---------------------------------------------------------------------------

export type EstadoVeredicto = "valida" | "dudosa" | "no_corresponde" | "no_evaluada";

/** Taxonomía del área, heredada del relevamiento del bot propio de Ambiente. */
export type CategoriaFoto =
  | "basural"
  | "volcadero"
  | "rnh"
  | "barrido"
  | "limpieza_cestos"
  | "otros";

/**
 * Lo que el modelo de visión dijo de la foto.
 *
 * Vive acá y no en `ia/` porque viaja pegado a la media del mensaje entrante, y
 * `mensajeria.ts` es la hoja que importan todos: un tipo de mensajería que
 * importara de `ia/` invertiría la dependencia.
 */
export interface VeredictoFoto {
  readonly veredicto: EstadoVeredicto;
  /** null cuando el veredicto es no_corresponde (no hay residuos que clasificar). */
  readonly categoria: CategoriaFoto | null;
  /** Una frase corta del modelo: qué se ve. La lee el área, y el vecino si se repregunta. */
  readonly detalle: string | null;
}

export interface MediaEntrante {
  readonly tipo: TipoMedia;
  /**
   * Referencia del archivo EN EL CANAL de origen (`file_id` en Telegram, id de
   * media en WhatsApp). No es una URL ni un archivo: el adaptador sabe cómo
   * resolverla y el worker la descarga después.
   *
   * Se guarda la referencia y no los bytes a propósito: el flujo tiene que
   * poder avanzar sin esperar la descarga de una foto de 5 MB.
   */
  readonly referencia: string;
  readonly mime?: string | null;
  readonly bytes?: number | null;
  /**
   * Veredicto de la verificación por visión, si el orquestador la corrió.
   *
   * Es DATO para el reductor puro: el flujo lo lee, jamás lo produce. Ausente
   * significa que no se corrió — foto suelta sin flujo, un paso que no espera
   * foto, o la visión apagada desde el panel.
   */
  readonly veredicto?: VeredictoFoto | null;
}

export interface MensajeEntrante {
  readonly canal: Canal;
  /** Identificador del usuario en ese canal: chat id, o teléfono en WhatsApp. */
  readonly canalUsuarioId: string;
  readonly nombreUsuario?: string | null;
  readonly telefono?: string | null;
  readonly texto: string | null;
  readonly media?: MediaEntrante | null;
  /**
   * Si el vecino tocó un botón, el `id` de la opción elegida.
   *
   * Se separa del texto porque una elección es un dato estructurado y no hay
   * que volver a interpretarla con lenguaje natural. En WhatsApp, donde un
   * usuario puede escribir "1" en vez de tocar el botón, el adaptador es el
   * que decide si eso cuenta como selección.
   */
  readonly seleccion?: string | null;
  /**
   * Id del mensaje EN EL CANAL de origen (el «wamid» en WhatsApp). Es la llave
   * del dedupe de la migración 035: los webhooks de Meta se reintentan, y dos
   * entregas del mismo wamid tienen que producir UN solo turno. Telegram manda
   * null a propósito — el long polling entrega una sola vez.
   */
  readonly canalMensajeId?: string | null;
  readonly recibidoEn: Date;
}

export interface OpcionRespuesta {
  /** Vuelve como `seleccion` en el próximo mensaje entrante. */
  readonly id: string;
  readonly etiqueta: string;
}

/** Qué está esperando el bot. El adaptador lo usa para ajustar la interfaz. */
export type Espera = "texto" | "imagen" | "opcion" | "nada";

export interface MensajeSaliente {
  readonly texto: string;
  readonly opciones?: readonly OpcionRespuesta[];
  readonly espera?: Espera;
  /**
   * El texto ya viene listo para mostrar, en texto plano.
   *
   * El formato NO lo decide el núcleo ni el modelo: cada canal escapa distinto
   * (Telegram con MarkdownV2 o HTML, WhatsApp con su propio subconjunto) y un
   * asterisco suelto rompe el envío. El adaptador es el único que formatea.
   */
  readonly enfasis?: readonly string[];
}

/** Construye un saliente simple, que es el caso más común. */
export function decir(texto: string, espera: Espera = "texto"): MensajeSaliente {
  return { texto, espera };
}

/** Construye un saliente con opciones cerradas. */
export function preguntar(
  texto: string,
  opciones: readonly OpcionRespuesta[],
): MensajeSaliente {
  return { texto, opciones, espera: "opcion" };
}

/** ¿El mensaje trae una imagen? Lo consultan los pasos con foto bloqueante. */
export function tieneImagen(entrante: MensajeEntrante): boolean {
  return entrante.media?.tipo === "imagen";
}

/**
 * Texto útil del mensaje: la selección si tocó un botón, el texto si escribió.
 *
 * Unifica los dos casos para que un paso no tenga que preguntarse cada vez de
 * dónde viene la respuesta.
 */
export function textoEfectivo(entrante: MensajeEntrante): string {
  return (entrante.seleccion ?? entrante.texto ?? "").trim();
}
