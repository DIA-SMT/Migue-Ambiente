/**
 * Traducción de mensajes de la Cloud API al mensaje canónico del dominio.
 *
 * Es el gemelo de telegram/normalizar.ts: puro, sin red, sin credenciales. El
 * dominio no sabe que WhatsApp existe; esto es lo único que conoce su formato.
 *
 * Dos reglas que definen el archivo:
 *
 *   · El adaptador NO traduce números a `seleccion`. Un «3» escrito viaja como
 *     texto, y el dominio ya sabe resolverlo contra las opciones ofrecidas
 *     (numeroDeOpcion/resolverOpcion). `seleccion` se completa SÓLO con los ids
 *     de los botones e ítems de lista, que son datos estructurados.
 *
 *   · Devolver null significa «esto no merece un turno»: una reaction, un
 *     sticker, un aviso de sistema. Responderle a un gesto es ruido — y en
 *     WhatsApp, cuota gastada.
 */
import type { MediaEntrante, MensajeEntrante } from "@migue/dominio";
import type { MensajeCrudo } from "./webhook.ts";

function comoObjeto(valor: unknown): Record<string, unknown> {
  return typeof valor === "object" && valor !== null ? (valor as Record<string, unknown>) : {};
}

function comoTexto(valor: unknown): string {
  return typeof valor === "string" ? valor : "";
}

function textoONull(valor: unknown): string | null {
  const t = comoTexto(valor).trim();
  return t === "" ? null : t;
}

/** Epoch en segundos (string de Meta) → Date. Inválido o ausente → ahora. */
function fechaDe(timestamp: string): Date {
  const segundos = Number(timestamp);
  return Number.isFinite(segundos) && segundos > 0 ? new Date(segundos * 1000) : new Date();
}

/** Los gestos y avisos que no son un mensaje del vecino. */
const SIN_TURNO = new Set(["reaction", "sticker", "system"]);

interface Traduccion {
  readonly texto: string | null;
  readonly media: MediaEntrante | null;
  readonly seleccion: string | null;
}

function traducir(tipo: string, crudo: Record<string, unknown>): Traduccion | null {
  const nada = { texto: null, media: null, seleccion: null };

  switch (tipo) {
    case "text":
      return { ...nada, texto: textoONull(comoObjeto(crudo["text"])["body"]) };

    case "image": {
      const imagen = comoObjeto(crudo["image"]);
      const referencia = comoTexto(imagen["id"]);
      if (referencia === "") return nada;
      return {
        // El pie de la foto cuenta como texto, igual que en Telegram: «Lamadrid
        // 50, son 4 bolsas» viene ahí y perderlo es volver a preguntarlo.
        texto: textoONull(imagen["caption"]),
        media: { tipo: "imagen", referencia, mime: textoONull(imagen["mime_type"]), bytes: null },
        seleccion: null,
      };
    }

    case "document": {
      const documento = comoObjeto(crudo["document"]);
      const referencia = comoTexto(documento["id"]);
      if (referencia === "") return nada;
      const mime = textoONull(documento["mime_type"]);
      return {
        texto: textoONull(documento["caption"]),
        // Una foto mandada «como archivo» sigue siendo una foto: el flujo del
        // retiro la tiene que aceptar. Misma regla que Telegram.
        media: {
          tipo: mime?.startsWith("image/") ? "imagen" : "documento",
          referencia,
          mime,
          bytes: null,
        },
        seleccion: null,
      };
    }

    case "audio": {
      const audio = comoObjeto(crudo["audio"]);
      const referencia = comoTexto(audio["id"]);
      if (referencia === "") return nada;
      return {
        ...nada,
        media: { tipo: "audio", referencia, mime: textoONull(audio["mime_type"]), bytes: null },
      };
    }

    case "video": {
      const video = comoObjeto(crudo["video"]);
      const referencia = comoTexto(video["id"]);
      if (referencia === "") return nada;
      return {
        texto: textoONull(video["caption"]),
        media: { tipo: "video", referencia, mime: textoONull(video["mime_type"]), bytes: null },
        seleccion: null,
      };
    }

    case "location": {
      // Igual que Telegram: la spec exige la dirección ESCRITA, así que el GPS
      // se registra como media y el flujo va a pedir calle y altura igual.
      const ubicacion = comoObjeto(crudo["location"]);
      const lat = ubicacion["latitude"];
      const lon = ubicacion["longitude"];
      if (typeof lat !== "number" || typeof lon !== "number") return nada;
      return {
        ...nada,
        media: { tipo: "ubicacion", referencia: `${lat},${lon}`, mime: null, bytes: null },
      };
    }

    case "interactive": {
      const interactivo = comoObjeto(crudo["interactive"]);
      const boton = comoObjeto(interactivo["button_reply"]);
      const fila = comoObjeto(interactivo["list_reply"]);
      const id = textoONull(boton["id"]) ?? textoONull(fila["id"]);
      // Un interactivo de otro subtipo (nfm_reply, etc.) cae al «no entendí»
      // del dominio, que es mejor que el silencio.
      return { ...nada, seleccion: id };
    }

    case "button": {
      // Quick-reply de una plantilla. No mandamos plantillas en la v1, pero si
      // alguna vez llega, el payload es la selección.
      const boton = comoObjeto(crudo["button"]);
      return { ...nada, seleccion: textoONull(boton["payload"]) ?? textoONull(boton["text"]) };
    }

    default:
      // `unsupported`, `contacts`, `order`, lo que Meta invente: el vecino SÍ
      // intentó mandar algo. Se normaliza vacío y el orquestador le termina
      // mostrando el menú — mejor que el silencio.
      return nada;
  }
}

/** Traduce un mensaje del sobre. null = no merece turno (gesto, aviso). */
export function normalizarMensaje(mensaje: MensajeCrudo): MensajeEntrante | null {
  if (SIN_TURNO.has(mensaje.tipo)) return null;
  if (mensaje.de === "") return null;

  const traduccion = traducir(mensaje.tipo, mensaje.crudo);
  if (traduccion === null) return null;

  return {
    canal: "whatsapp",
    // En WhatsApp el identificador del canal ES el teléfono: por eso acá
    // `telefono` viene lleno, a diferencia de Telegram (null a propósito).
    canalUsuarioId: mensaje.de,
    nombreUsuario: mensaje.nombre,
    telefono: mensaje.de,
    texto: traduccion.texto,
    media: traduccion.media,
    seleccion: traduccion.seleccion,
    // El wamid: la llave del dedupe de la 035 contra los reintentos de Meta.
    canalMensajeId: mensaje.id,
    recibidoEn: fechaDe(mensaje.timestamp),
  };
}
