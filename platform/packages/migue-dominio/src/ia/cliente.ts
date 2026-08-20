/**
 * Cliente de OpenRouter.
 *
 * `fetch` directo en lugar del SDK de OpenAI: la superficie que usamos es un
 * solo endpoint, y escribirlo a mano deja los reintentos y los tiempos de
 * espera bajo control explícito. Del otro lado hay un vecino esperando en un
 * chat, así que cuánto se espera y cuántas veces se reintenta son decisiones
 * del producto, no valores por defecto de una librería.
 */

const URL_BASE = "https://openrouter.ai/api/v1";

export interface MensajeChat {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface OpcionesChat {
  readonly modelo: string;
  readonly mensajes: readonly MensajeChat[];
  readonly maxTokens?: number;
  readonly temperatura?: number;
  /** Pide que la respuesta sea un objeto JSON. Lo usa el router de intención. */
  readonly json?: boolean;
  readonly timeoutMs?: number;
  readonly reintentos?: number;
}

export interface RespuestaChat {
  readonly texto: string;
  /** Modelo que respondió de verdad: OpenRouter puede enrutar a otro. */
  readonly modelo: string;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
  readonly costoUsd: number | null;
  readonly latenciaMs: number;
}

export class ErrorDeIA extends Error {
  readonly estado: number | null;
  readonly reintentable: boolean;

  constructor(mensaje: string, estado: number | null, reintentable: boolean) {
    super(mensaje);
    this.name = "ErrorDeIA";
    this.estado = estado;
    this.reintentable = reintentable;
  }
}

/**
 * Tiempo de espera por defecto.
 *
 * 25 segundos: por encima de eso el vecino ya asumió que el bot no le va a
 * contestar, y seguir esperando sólo empeora la experiencia. Es mejor caer al
 * mensaje de «no tengo esa información» que dejarlo mirando la pantalla.
 */
const TIMEOUT_POR_DEFECTO_MS = 25_000;

/** Dos reintentos: alcanza para un 429 o un 502 puntual, sin estirar la espera. */
const REINTENTOS_POR_DEFECTO = 2;

function clave(): string {
  const k = process.env["OPENROUTER_API_KEY"]?.trim();
  if (!k) {
    throw new ErrorDeIA(
      "Falta OPENROUTER_API_KEY. En la VPS vive en /srv/bots/.secrets/migue.env",
      null,
      false,
    );
  }
  return k;
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(opciones: OpcionesChat): Promise<RespuestaChat> {
  const timeoutMs = opciones.timeoutMs ?? TIMEOUT_POR_DEFECTO_MS;
  const maxReintentos = opciones.reintentos ?? REINTENTOS_POR_DEFECTO;

  let ultimoError: ErrorDeIA | null = null;

  for (let intento = 0; intento <= maxReintentos; intento++) {
    if (intento > 0) {
      // Retroceso exponencial con techo: 400 ms, 800 ms. Más que eso ya excede
      // lo que alguien tolera esperando en un chat.
      await esperar(Math.min(400 * 2 ** (intento - 1), 1500));
    }

    try {
      return await unaLlamada(opciones, timeoutMs);
    } catch (error) {
      const err =
        error instanceof ErrorDeIA
          ? error
          : new ErrorDeIA(String(error), null, false);
      ultimoError = err;
      if (!err.reintentable) throw err;
    }
  }

  throw ultimoError ?? new ErrorDeIA("falló sin error registrado", null, false);
}

async function unaLlamada(opciones: OpcionesChat, timeoutMs: number): Promise<RespuestaChat> {
  const controlador = new AbortController();
  const corte = setTimeout(() => controlador.abort(), timeoutMs);
  const inicio = Date.now();

  try {
    const respuesta = await fetch(`${URL_BASE}/chat/completions`, {
      method: "POST",
      signal: controlador.signal,
      headers: {
        Authorization: `Bearer ${clave()}`,
        "Content-Type": "application/json",
        // OpenRouter usa estos dos para atribución en su tablero.
        "HTTP-Referer": "https://smt.gob.ar",
        "X-Title": "Migue Ambiente",
      },
      body: JSON.stringify({
        model: opciones.modelo,
        messages: opciones.mensajes,
        max_tokens: opciones.maxTokens ?? 700,
        // 0.2 y no 0: algo de variación evita respuestas acartonadas, pero
        // sigue siendo bajo porque acá no queremos creatividad sino fidelidad
        // al contexto.
        temperature: opciones.temperatura ?? 0.2,
        ...(opciones.json ? { response_format: { type: "json_object" } } : {}),
        // Pide el costo real de la llamada en la respuesta, en vez de estimarlo
        // desde una tabla de precios que se desactualiza.
        usage: { include: true },
      }),
    });

    if (!respuesta.ok) {
      const cuerpo = await respuesta.text().catch(() => "");
      // 429 y 5xx son transitorios. 401 y 400 no: reintentarlos sólo gasta
      // tiempo mientras el vecino espera.
      const reintentable = respuesta.status === 429 || respuesta.status >= 500;
      throw new ErrorDeIA(
        `OpenRouter respondió ${respuesta.status}: ${cuerpo.slice(0, 300)}`,
        respuesta.status,
        reintentable,
      );
    }

    const cuerpo = (await respuesta.json()) as Record<string, unknown>;

    // OpenRouter devuelve errores con HTTP 200 en algunos casos.
    if (cuerpo["error"]) {
      const detalle = cuerpo["error"] as { message?: string; code?: number };
      throw new ErrorDeIA(
        `OpenRouter: ${detalle.message ?? JSON.stringify(detalle)}`,
        detalle.code ?? null,
        false,
      );
    }

    const opcion = (cuerpo["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
    const mensaje = opcion?.["message"] as { content?: string } | undefined;
    const texto = mensaje?.content?.trim() ?? "";

    if (texto === "") {
      throw new ErrorDeIA("OpenRouter devolvió una respuesta vacía", null, true);
    }

    const uso = (cuerpo["usage"] ?? {}) as Record<string, unknown>;

    return {
      texto,
      modelo: (cuerpo["model"] as string | undefined) ?? opciones.modelo,
      tokensEntrada: Number(uso["prompt_tokens"] ?? 0),
      tokensSalida: Number(uso["completion_tokens"] ?? 0),
      costoUsd: uso["cost"] === undefined ? null : Number(uso["cost"]),
      latenciaMs: Date.now() - inicio,
    };
  } catch (error) {
    if (error instanceof ErrorDeIA) throw error;
    // AbortError: se agotó el tiempo. Es reintentable, pero el reintento suele
    // agotarse igual, así que el llamador va a caer al fallback y está bien.
    if (error instanceof Error && error.name === "AbortError") {
      throw new ErrorDeIA(`OpenRouter no respondió en ${timeoutMs} ms`, null, true);
    }
    throw new ErrorDeIA(`fallo de red contra OpenRouter: ${String(error)}`, null, true);
  } finally {
    clearTimeout(corte);
  }
}

/**
 * Parsea la respuesta de un modelo que debía devolver JSON.
 *
 * Los modelos agregan cercos de markdown y texto explicativo aunque se les pida
 * lo contrario, así que se limpia antes de parsear. Devuelve null en lugar de
 * lanzar: el llamador decide si eso es un fallback o un error, y en un bot
 * conversacional casi siempre es un fallback.
 */
export function parsearJson<T>(texto: string): T | null {
  let limpio = texto.trim();

  // Cerco de markdown: ```json ... ``` o ``` ... ```
  const cerco = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(limpio);
  if (cerco?.[1]) limpio = cerco[1].trim();

  try {
    return JSON.parse(limpio) as T;
  } catch {
    // El parseo directo falló: puede haber texto antes, después, o los dos.
    // Se recorta al primer `{` y al último `}`.
    //
    // El chequeo tiene que ser «falló el parseo» y no «no empieza con {»: un
    // modelo agrega texto al final tan seguido como al principio, y
    // `{"a":1} espero que sirva` empieza con { pero no parsea.
    const inicio = limpio.indexOf("{");
    const fin = limpio.lastIndexOf("}");
    if (inicio === -1 || fin <= inicio) return null;
    try {
      return JSON.parse(limpio.slice(inicio, fin + 1)) as T;
    } catch {
      return null;
    }
  }
}
