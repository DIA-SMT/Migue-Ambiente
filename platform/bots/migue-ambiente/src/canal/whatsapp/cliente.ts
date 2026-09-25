/**
 * El cliente de la Graph API para ENVIAR.
 *
 * fetch directo y sin SDK, como el resto del proyecto: la superficie que usamos
 * son dos endpoints, y los reintentos y tiempos de espera son decisiones del
 * producto — del otro lado hay un vecino esperando en un chat.
 */
import type { EnvioWhatsApp } from "./renderizar.ts";

const URL_GRAPH = "https://graph.facebook.com";
export const VERSION_API_DEFAULT = "v23.0";

/** Mismo criterio que el cliente de IA: 429 o 5xx puntual, sin estirar la espera. */
const TIEMPO_LIMITE_MS = 15_000;
const REINTENTOS = 2;

export interface ConfigWhatsApp {
  readonly token: string;
  readonly numeroId: string;
  readonly versionApi?: string | undefined;
}

export class ErrorDeWhatsApp extends Error {
  readonly estado: number | null;
  /** Los tres datos que sirven para reclamarle a Meta. */
  readonly codigo: number | null;
  readonly subcodigo: number | null;
  readonly fbtraceId: string | null;
  readonly reintentable: boolean;

  constructor(opciones: {
    mensaje: string;
    estado: number | null;
    codigo?: number | null;
    subcodigo?: number | null;
    fbtraceId?: string | null;
    reintentable: boolean;
  }) {
    super(opciones.mensaje);
    this.name = "ErrorDeWhatsApp";
    this.estado = opciones.estado;
    this.codigo = opciones.codigo ?? null;
    this.subcodigo = opciones.subcodigo ?? null;
    this.fbtraceId = opciones.fbtraceId ?? null;
    this.reintentable = opciones.reintentable;
  }
}

/** Interpreta el error del cuerpo de Meta. Exportada para probarla sin red. */
export function errorDeMeta(estado: number, cuerpo: unknown): ErrorDeWhatsApp {
  const error =
    typeof cuerpo === "object" && cuerpo !== null
      ? ((cuerpo as Record<string, unknown>)["error"] as Record<string, unknown> | undefined)
      : undefined;
  return new ErrorDeWhatsApp({
    mensaje: `Meta devolvió ${estado}: ${String(error?.["message"] ?? "sin detalle")}`,
    estado,
    codigo: typeof error?.["code"] === "number" ? (error["code"] as number) : null,
    subcodigo:
      typeof error?.["error_subcode"] === "number" ? (error["error_subcode"] as number) : null,
    fbtraceId: typeof error?.["fbtrace_id"] === "string" ? (error["fbtrace_id"] as string) : null,
    reintentable: estado === 429 || estado >= 500,
  });
}

/**
 * El cuerpo del POST /messages para un envío. PURO y exportado para probarlo:
 * es la única parte con forma de wire, y equivocarla se paga en producción.
 */
export function cuerpoDeEnvio(destinatario: string, envio: EnvioWhatsApp): Record<string, unknown> {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: destinatario,
  };

  switch (envio.tipo) {
    case "texto":
      // Vista previa de links apagada: mismo criterio que Telegram.
      return { ...base, type: "text", text: { body: envio.texto, preview_url: false } };

    case "botones":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: envio.texto },
          action: {
            buttons: envio.botones.map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.titulo },
            })),
          },
        },
      };

    case "lista":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: envio.texto },
          action: {
            button: envio.boton,
            // Una sola sección y sin título: el menú no tiene categorías.
            sections: [
              {
                rows: envio.filas.map((f) => ({
                  id: f.id,
                  title: f.titulo,
                  ...(f.descripcion === null ? {} : { description: f.descripcion }),
                })),
              },
            ],
          },
        },
      };
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function llamar(
  config: ConfigWhatsApp,
  cuerpo: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const version = config.versionApi?.trim() || VERSION_API_DEFAULT;
  const url = `${URL_GRAPH}/${version}/${config.numeroId}/messages`;

  let ultimoError: ErrorDeWhatsApp | null = null;

  for (let intento = 0; intento <= REINTENTOS; intento++) {
    if (intento > 0) await esperar(400 * intento);

    try {
      const respuesta = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });

      const contenido = (await respuesta.json().catch(() => ({}))) as Record<string, unknown>;
      if (respuesta.ok) return contenido;

      const error = errorDeMeta(respuesta.status, contenido);
      if (!error.reintentable) throw error;
      ultimoError = error;
    } catch (fallo) {
      if (fallo instanceof ErrorDeWhatsApp) {
        if (!fallo.reintentable) throw fallo;
        ultimoError = fallo;
        continue;
      }
      // Timeout o red caída: reintentable.
      ultimoError = new ErrorDeWhatsApp({
        mensaje: String(fallo),
        estado: null,
        reintentable: true,
      });
    }
  }

  throw ultimoError ?? new ErrorDeWhatsApp({ mensaje: "falló sin error", estado: null, reintentable: false });
}

/** Envía un mensaje y devuelve el wamid del saliente. */
export async function enviarMensaje(
  config: ConfigWhatsApp,
  destinatario: string,
  envio: EnvioWhatsApp,
): Promise<string> {
  const contenido = await llamar(config, cuerpoDeEnvio(destinatario, envio));
  const mensajes = contenido["messages"];
  const primero = Array.isArray(mensajes) ? (mensajes[0] as Record<string, unknown>) : undefined;
  return typeof primero?.["id"] === "string" ? (primero["id"] as string) : "";
}

/**
 * Marca el mensaje del vecino como leído Y muestra «escribiendo…», en una sola
 * llamada. Es el equivalente del `replyWithChatAction` de Telegram: la cadena
 * de conocimiento tarda unos segundos y sin señal el vecino asume que el
 * mensaje no llegó. Best-effort: quien llama hace .catch — un doble check gris
 * jamás puede cortar una respuesta.
 */
export async function marcarLeidoYEscribiendo(
  config: ConfigWhatsApp,
  wamid: string,
): Promise<void> {
  await llamar(config, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: wamid,
    typing_indicator: { type: "text" },
  });
}

/** Los tres datos del error, listos para el log. */
export function trazaDeError(error: unknown): Record<string, unknown> {
  if (error instanceof ErrorDeWhatsApp) {
    return {
      estado: error.estado,
      codigo: error.codigo,
      subcodigo: error.subcodigo,
      fbtrace: error.fbtraceId,
      err: error.message,
    };
  }
  return { err: String(error) };
}
