/**
 * Descarga de archivos de la Cloud API de WhatsApp.
 *
 * Dos pasos, como los dos de Telegram: `GET /{media_id}` devuelve una URL
 * efímera (~5 minutos) y el mime; después se baja de esa URL. Las DOS llamadas
 * llevan el Bearer — sin el header, el host de archivos de Meta devuelve 404
 * aunque la URL sea válida.
 *
 * Sin SDK, igual que el resto del proyecto: son dos llamadas HTTP y los
 * reintentos y tiempos de espera son decisiones del producto.
 */
import { MediaVencidaError, type MediaDescargada } from "../media.ts";

/** Mismo techo que Telegram: acá se bajan fotos de vecinos, no backups. */
const MAXIMO_BYTES = 20 * 1024 * 1024;
const TIEMPO_LIMITE_MS = 30_000;

export const VERSION_API_DEFAULT = "v23.0";

export interface OpcionesDescargaWhatsApp {
  readonly token: string;
  readonly versionApi?: string | undefined;
}

/** Lo que devuelve `GET /{media_id}`. */
interface MediaDeMeta {
  url?: string;
  mime_type?: string;
  file_size?: number;
}

/** La extensión por el mime: la inversa de `mimeDeRuta` de Telegram. */
const EXTENSION_POR_MIME: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/amr": "amr",
  "video/mp4": "mp4",
};

function extensionDe(mime: string): string {
  return EXTENSION_POR_MIME[mime.split(";")[0]!.trim().toLowerCase()] ?? "bin";
}

async function pedir(url: string, token: string, referencia: string): Promise<Response> {
  const respuesta = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
  });

  if (respuesta.status === 400 || respuesta.status === 404) {
    // Media borrada o vencida (Meta la retiene ~30 días), o URL efímera
    // caducada. Volver a pedir lo mismo va a fallar igual.
    throw new MediaVencidaError("WhatsApp", referencia, `HTTP ${respuesta.status}`);
  }
  if (!respuesta.ok) {
    // 429 y 5xx son problemas del momento: se propagan como error común y el
    // worker reintenta.
    throw new Error(`WhatsApp devolvió ${respuesta.status} para ${referencia.slice(0, 24)}`);
  }
  return respuesta;
}

export async function descargarDeWhatsApp(
  referencia: string,
  opciones: OpcionesDescargaWhatsApp,
): Promise<MediaDescargada> {
  const version = opciones.versionApi?.trim() || VERSION_API_DEFAULT;

  // Paso 1: el media id se canjea por la URL efímera.
  const meta = (await (
    await pedir(
      `https://graph.facebook.com/${version}/${encodeURIComponent(referencia)}`,
      opciones.token,
      referencia,
    )
  ).json()) as MediaDeMeta;

  if (!meta.url) {
    throw new MediaVencidaError("WhatsApp", referencia, "Meta no devolvió la URL del archivo");
  }
  if ((meta.file_size ?? 0) > MAXIMO_BYTES) {
    // No es reintentable: el archivo no va a adelgazar.
    throw new MediaVencidaError(
      "WhatsApp",
      referencia,
      `pesa ${Math.round((meta.file_size ?? 0) / 1048576)} MB y el tope son 20 MB`,
    );
  }

  // Paso 2: la descarga en sí, también con Bearer.
  const archivo = await pedir(meta.url, opciones.token, referencia);
  const datos = new Uint8Array(await archivo.arrayBuffer());
  if (datos.length === 0) {
    throw new MediaVencidaError("WhatsApp", referencia, "el archivo vino vacío");
  }
  if (datos.length > MAXIMO_BYTES) {
    throw new MediaVencidaError("WhatsApp", referencia, "el archivo excede el tope de 20 MB");
  }

  const mime = meta.mime_type?.trim() || "application/octet-stream";
  return {
    datos,
    mime,
    // El media id es opaco pero único: alcanza como nombre, igual que el
    // file_unique_id de Telegram.
    nombre: `${referencia}.${extensionDe(mime)}`,
  };
}
