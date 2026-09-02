/**
 * Traduce lo que llega de Telegram al mensaje canónico del núcleo.
 *
 * Esta es una de las dos únicas funciones del sistema que conocen el formato de
 * Telegram. La otra es `renderizar`. Todo lo demás trabaja con
 * `MensajeEntrante` y `MensajeSaliente`, y por eso sumar WhatsApp va a ser
 * escribir dos archivos como estos y nada más.
 */
import type { MensajeEntrante, MediaEntrante, TipoMedia } from "@migue/dominio";
import type { CallbackQuery, Message } from "grammy/types";

/**
 * Extrae la media de un mensaje de Telegram.
 *
 * De las fotos se toma la MÁS GRANDE del arreglo: Telegram envía varias
 * resoluciones y las chicas están comprimidas al punto de que no se distingue
 * si son cinco bolsas o quince.
 *
 * Los documentos con mime de imagen cuentan como imagen: mucha gente manda las
 * fotos «como archivo» para que no se compriman, y rechazarlas por venir en
 * otro campo sería absurdo cuando la foto es justo lo que pedimos.
 */
function extraerMedia(mensaje: Message): MediaEntrante | null {
  if (mensaje.photo && mensaje.photo.length > 0) {
    const mayor = mensaje.photo[mensaje.photo.length - 1]!;
    return {
      tipo: "imagen",
      referencia: mayor.file_id,
      mime: "image/jpeg",
      bytes: mayor.file_size ?? null,
    };
  }

  if (mensaje.document) {
    const mime = mensaje.document.mime_type ?? null;
    return {
      tipo: mime?.startsWith("image/") ? "imagen" : "documento",
      referencia: mensaje.document.file_id,
      mime,
      bytes: mensaje.document.file_size ?? null,
    };
  }

  const simples: ReadonlyArray<readonly [TipoMedia, { file_id: string; file_size?: number } | undefined]> = [
    ["video", mensaje.video],
    ["audio", mensaje.voice ?? mensaje.audio],
  ];
  for (const [tipo, archivo] of simples) {
    if (archivo) {
      return { tipo, referencia: archivo.file_id, mime: null, bytes: archivo.file_size ?? null };
    }
  }

  if (mensaje.location) {
    // La spec descarta el GPS a propósito: «para evitar errores de precisión,
    // el usuario debe escribirla». Se registra que llegó una ubicación, pero la
    // referencia son las coordenadas y ningún flujo la usa como dirección.
    return {
      tipo: "ubicacion",
      referencia: `${mensaje.location.latitude},${mensaje.location.longitude}`,
      mime: null,
      bytes: null,
    };
  }

  return null;
}

/** Nombre para mostrar, armado de lo que Telegram tenga disponible. */
function nombreDe(de: { first_name?: string; last_name?: string; username?: string } | undefined): string | null {
  if (!de) return null;
  const completo = [de.first_name, de.last_name].filter(Boolean).join(" ").trim();
  if (completo !== "") return completo;
  return de.username ? `@${de.username}` : null;
}

export function normalizarMensaje(mensaje: Message): MensajeEntrante {
  return {
    canal: "telegram",
    canalUsuarioId: String(mensaje.chat.id),
    nombreUsuario: nombreDe(mensaje.from),
    // Telegram no da el teléfono salvo que el usuario lo comparta
    // explícitamente. No se lo pide: la spec no lo necesita para Telegram.
    telefono: null,
    // El pie de una foto es texto útil: mucha gente manda la foto con la
    // dirección escrita ahí mismo.
    texto: mensaje.text ?? mensaje.caption ?? null,
    media: extraerMedia(mensaje),
    seleccion: null,
    // Telegram entrega una sola vez (long polling): sin id no hay dedupe que hacer.
    canalMensajeId: null,
    recibidoEn: new Date(mensaje.date * 1000),
  };
}

/**
 * Traduce el toque de un botón.
 *
 * La elección llega en `seleccion` y no en `texto` porque es un dato
 * estructurado: volver a interpretarla con lenguaje natural sería tirar
 * información que ya tenemos exacta.
 */
export function normalizarSeleccion(consulta: CallbackQuery): MensajeEntrante | null {
  if (!consulta.message) return null;

  return {
    canal: "telegram",
    canalUsuarioId: String(consulta.message.chat.id),
    nombreUsuario: nombreDe(consulta.from),
    telefono: null,
    texto: null,
    media: null,
    seleccion: consulta.data ?? null,
    canalMensajeId: null,
    recibidoEn: new Date(),
  };
}
