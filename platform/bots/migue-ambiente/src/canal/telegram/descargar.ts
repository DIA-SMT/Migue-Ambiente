/**
 * Descarga de archivos que mandó un vecino por Telegram.
 *
 * Es lo único del worker que sabe que Telegram existe, y por eso vive acá y no
 * en `@migue/dominio`. El dominio recibe una referencia opaca y no le importa si
 * atrás hay un `getFile` o una URL firmada de WhatsApp: es lo mismo que va a
 * permitir sumar el canal oficial sin tocar la lógica.
 *
 * No usa grammY: son dos llamadas HTTP y traer el cliente entero al worker
 * significaría también traer su manejo de updates, que el worker no usa.
 */
import { createLogger } from "@bots/core";

const log = createLogger("worker:telegram");

/**
 * 20 MB. Es el tope que la API de bots de Telegram permite DESCARGAR, así que
 * más que un límite propio es el límite real del canal.
 */
const MAXIMO_BYTES = 20 * 1024 * 1024;

/** 30 segundos. Una foto de teléfono son 2 a 5 MB; más que esto es un problema. */
const TIEMPO_LIMITE_MS = 30_000;

interface RespuestaTelegram<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/** Lo que devuelve `getFile`. */
interface ArchivoTelegram {
  file_id: string;
  file_unique_id: string;
  file_path?: string;
  file_size?: number;
}

// El contrato vive en ../media.ts desde que hay más de un canal. Se re-exporta
// para que el worker y las pruebas conserven sus imports.
import { MediaVencidaError, type MediaDescargada } from "../media.ts";
export { MediaVencidaError, type MediaDescargada } from "../media.ts";

/**
 * El mime por la extensión que devuelve Telegram en `file_path`.
 *
 * Telegram no informa el content-type en `getFile`, sólo una ruta como
 * `photos/file_42.jpg`. Se deduce de ahí, y ante la duda se guarda como binario:
 * es mejor un octet-stream que un jpeg mentido, porque el panel decide si puede
 * mostrarlo mirando el mime.
 */
function mimeDeRuta(ruta: string): { mime: string; extension: string } {
  const extension = (ruta.split(".").pop() ?? "").toLowerCase();
  const tabla: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    pdf: "application/pdf",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    m4a: "audio/mp4",
  };
  return { mime: tabla[extension] ?? "application/octet-stream", extension: extension || "bin" };
}

async function pedir<T>(url: string, referencia: string): Promise<T> {
  const respuesta = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_LIMITE_MS) });
  const cuerpo = (await respuesta.json()) as RespuestaTelegram<T>;

  if (!cuerpo.ok || cuerpo.result === undefined) {
    const motivo = cuerpo.description ?? `HTTP ${respuesta.status}`;
    // 400 con «file is temporarily unavailable» o «wrong file_id» significa que
    // el archivo no está más. 429 y 5xx son transitorios y sí conviene
    // reintentarlos, así que se distinguen.
    if (respuesta.status === 400 || respuesta.status === 404) {
      throw new MediaVencidaError("Telegram", referencia, motivo);
    }
    throw new Error(`Telegram respondió ${respuesta.status}: ${motivo}`);
  }
  return cuerpo.result;
}

/**
 * Baja un archivo de Telegram a partir de su `file_id`.
 *
 * Son dos pasos porque la API los separa: `getFile` da una ruta temporal y
 * después se baja de otro host. La ruta vence, así que no se puede guardar para
 * después: hay que bajar en el momento.
 */
export async function descargarDeTelegram(
  referencia: string,
  token: string,
): Promise<MediaDescargada> {
  const archivo = await pedir<ArchivoTelegram>(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(referencia)}`,
    referencia,
  );

  if (!archivo.file_path) {
    throw new MediaVencidaError("Telegram", referencia, "getFile no devolvió una ruta");
  }
  if ((archivo.file_size ?? 0) > MAXIMO_BYTES) {
    // No es reintentable: el archivo no va a adelgazar.
    throw new MediaVencidaError(
      "Telegram",
      referencia,
      `pesa ${Math.round((archivo.file_size ?? 0) / 1048576)} MB y el tope de la API son 20 MB`,
    );
  }

  const respuesta = await fetch(
    `https://api.telegram.org/file/bot${token}/${archivo.file_path}`,
    { signal: AbortSignal.timeout(TIEMPO_LIMITE_MS) },
  );
  if (!respuesta.ok) {
    if (respuesta.status === 404) {
      throw new MediaVencidaError("Telegram", referencia, "la ruta temporal ya venció");
    }
    throw new Error(`no pude bajar el archivo: HTTP ${respuesta.status}`);
  }

  const datos = new Uint8Array(await respuesta.arrayBuffer());
  if (datos.length === 0) throw new MediaVencidaError("Telegram", referencia, "el archivo vino vacío");

  const { mime, extension } = mimeDeRuta(archivo.file_path);
  log.debug(
    { referencia: referencia.slice(0, 16), bytes: datos.length, mime },
    "archivo bajado de Telegram",
  );

  return { datos, mime, nombre: `${archivo.file_unique_id}.${extension}` };
}
