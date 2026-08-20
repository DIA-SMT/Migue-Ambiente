/**
 * Qué hace el worker con cada trabajo de la cola.
 *
 * Los efectos entran por parámetro —bajar el archivo, escribir en la base,
 * encolar— igual que en el orquestador del bot. Así esta lógica se prueba sin
 * Supabase y sin red, que es la única forma de verificar los casos que importan:
 * el documento que ya no existe, el archivo que desapareció del Storage, el
 * documento sin texto.
 */
import { extraer, type Formato } from "./extraer.ts";
import type { FragmentoIndexable } from "./fragmentar.ts";

export type TipoTrabajo =
  | "ingestar_documento"
  | "reindexar_documento"
  | "borrar_documento"
  | "reindexar_todo";

export interface Trabajo {
  readonly id: string;
  readonly tipo: TipoTrabajo;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly intentos: number;
  readonly maxIntentos: number;
}

export interface DocumentoARindexar {
  readonly id: string;
  readonly titulo: string;
  readonly nombreArchivo: string;
  readonly formato: Formato;
  readonly rutaStorage: string;
}

export interface PuertosIngesta {
  /** Baja el archivo del Storage. Devuelve null si ya no está. */
  descargar(rutaStorage: string): Promise<Uint8Array | null>;
  /** Lee el documento. Devuelve null si lo borraron mientras esperaba en la cola. */
  leerDocumento(id: string): Promise<DocumentoARindexar | null>;
  /** Marca el documento como en proceso, para que el panel lo muestre. */
  marcarProcesando(id: string): Promise<void>;
  /** Marca el documento con un error legible por un administrador. */
  marcarError(id: string, detalle: string): Promise<void>;
  /** Reemplaza los fragmentos de forma atómica. Devuelve cuántos quedaron. */
  reemplazarFragmentos(
    documentoId: string,
    fragmentos: readonly FragmentoIndexable[],
    paginas: number,
    hash: string,
  ): Promise<number>;
  /** Borra el documento, sus fragmentos y su archivo del Storage. */
  borrarDocumento(id: string, rutaStorage: string | null): Promise<void>;
  /** Encola un reindexado por documento activo. Devuelve cuántos encoló. */
  encolarReindexado(): Promise<number>;
  registrar(nivel: "info" | "aviso" | "error", mensaje: string): void;
}

/**
 * Resultado de procesar un trabajo.
 *
 * `reintentable` es la decisión importante: un problema de red merece otro
 * intento, y un PDF escaneado no —reintentarlo tres veces es gastar tiempo para
 * llegar al mismo lugar, y mientras tanto la cola no avanza.
 */
export type ResultadoTrabajo =
  | { readonly ok: true; readonly detalle: string }
  | { readonly ok: false; readonly error: string; readonly reintentable: boolean };

/** Errores de contenido: no tiene sentido reintentarlos. */
const DEFINITIVOS = new Set(["FormatoNoSoportadoError", "SinTextoError"]);

function leerId(trabajo: Trabajo): string {
  const id = trabajo.payload["documento_id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new PayloadInvalidoError(trabajo.tipo, "documento_id");
  }
  return id;
}

export class PayloadInvalidoError extends Error {
  constructor(tipo: string, campo: string) {
    super(`El trabajo «${tipo}» llegó sin «${campo}» en el payload`);
    this.name = "PayloadInvalidoError";
  }
}

/**
 * Ingesta o reindexado, que son el mismo trabajo.
 *
 * La diferencia entre los dos tipos es sólo de dónde vino: `ingestar_documento`
 * lo encola una subida del panel y `reindexar_documento` un cambio de reglas o
 * una mejora del fragmentador. El procedimiento es idéntico, y tener un solo
 * camino evita que se arreglen bugs en uno y no en el otro.
 */
async function indexar(trabajo: Trabajo, puertos: PuertosIngesta): Promise<ResultadoTrabajo> {
  const documentoId = leerId(trabajo);
  const documento = await puertos.leerDocumento(documentoId);

  if (documento === null) {
    // No es un error: alguien borró el documento mientras el trabajo esperaba
    // en la cola. El trabajo cumplió su propósito, que era dejar la base
    // consistente con lo que el panel muestra.
    puertos.registrar("aviso", `el documento ${documentoId} ya no existe; nada que indexar`);
    return { ok: true, detalle: "el documento fue borrado antes de procesarse" };
  }

  await puertos.marcarProcesando(documento.id);

  const datos = await puertos.descargar(documento.rutaStorage);
  if (datos === null) {
    const detalle =
      `No se encontró el archivo en el Storage (${documento.rutaStorage}). ` +
      `Hay que volver a subirlo desde el panel.`;
    await puertos.marcarError(documento.id, detalle);
    // No se reintenta: el archivo no va a aparecer solo.
    return { ok: false, error: detalle, reintentable: false };
  }

  let resultado;
  try {
    resultado = await extraer(datos, documento.nombreArchivo, documento.formato);
  } catch (error) {
    const nombre = error instanceof Error ? error.name : "";
    const detalle = error instanceof Error ? error.message : String(error);
    const definitivo = DEFINITIVOS.has(nombre);
    // El detalle queda en el documento y lo lee un administrador en el panel,
    // así que va el mensaje completo y no un código.
    await puertos.marcarError(documento.id, detalle);
    return { ok: false, error: detalle, reintentable: !definitivo };
  }

  // El guardado también puede fallar, y su fallo es el más traicionero: el
  // documento ya quedó marcado como 'procesando', así que si no se lo marca en
  // error acá, el panel lo muestra girando para siempre y nadie sabe por qué.
  // Pasó de verdad al indexar el corpus: dos PDFs quedaron en 'procesando' con
  // el trabajo en 'error', y los dos estados se contradecían.
  let cantidad: number;
  try {
    cantidad = await puertos.reemplazarFragmentos(
      documento.id,
      resultado.fragmentos,
      resultado.cantidadPaginas,
      resultado.hash,
    );
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    await puertos.marcarError(documento.id, detalle);
    // Sí se reintenta: casi siempre es la red o la base, no el documento.
    return { ok: false, error: detalle, reintentable: true };
  }

  puertos.registrar(
    "info",
    `«${documento.titulo}»: ${cantidad} fragmentos, ${resultado.cantidadPaginas} páginas`,
  );

  return { ok: true, detalle: `${cantidad} fragmentos indexados` };
}

async function borrar(trabajo: Trabajo, puertos: PuertosIngesta): Promise<ResultadoTrabajo> {
  const documentoId = leerId(trabajo);
  const documento = await puertos.leerDocumento(documentoId);

  // Se pasa la ruta si se conoce, para borrar también el archivo. Si el
  // documento ya no está en la base, se intenta con la ruta del payload: el
  // panel la manda justamente para este caso.
  const rutaDelPayload = trabajo.payload["ruta_storage"];
  const ruta =
    documento?.rutaStorage ?? (typeof rutaDelPayload === "string" ? rutaDelPayload : null);

  await puertos.borrarDocumento(documentoId, ruta);
  return { ok: true, detalle: ruta === null ? "documento borrado" : "documento y archivo borrados" };
}

/**
 * Reindexado masivo.
 *
 * No reindexa nada por sí mismo: encola un trabajo por documento. Si hiciera
 * los ocho en una sola pasada, el fallo del quinto haría reintentar los cuatro
 * que ya estaban bien, y al agotar los intentos marcaría todo el lote en error
 * sin distinguir qué documento falló.
 */
async function reindexarTodo(puertos: PuertosIngesta): Promise<ResultadoTrabajo> {
  const encolados = await puertos.encolarReindexado();
  puertos.registrar("info", `reindexado masivo: ${encolados} documentos encolados`);
  return { ok: true, detalle: `${encolados} documentos encolados` };
}

export async function procesarTrabajo(
  trabajo: Trabajo,
  puertos: PuertosIngesta,
): Promise<ResultadoTrabajo> {
  try {
    switch (trabajo.tipo) {
      case "ingestar_documento":
      case "reindexar_documento":
        return await indexar(trabajo, puertos);
      case "borrar_documento":
        return await borrar(trabajo, puertos);
      case "reindexar_todo":
        return await reindexarTodo(puertos);
      default: {
        const nunca: never = trabajo.tipo;
        return {
          ok: false,
          error: `tipo de trabajo desconocido: ${String(nunca)}`,
          reintentable: false,
        };
      }
    }
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    // Un payload inválido no se arregla reintentando: lo generó mal quien lo
    // encoló.
    const definitivo = error instanceof PayloadInvalidoError;
    return { ok: false, error: detalle, reintentable: !definitivo };
  }
}
