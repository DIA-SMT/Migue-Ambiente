/**
 * Implementación real de los puertos de ingesta, contra Supabase.
 *
 * Todo lo que toca la red o la base vive acá; la lógica de qué hacer con cada
 * trabajo vive en `@migue/dominio/ingesta` y no sabe que Supabase existe.
 */
import { createLogger } from "@bots/core";
import { obtenerCliente } from "@migue/dominio";
import {
  formatoDe,
  type DocumentoARindexar,
  type FragmentoIndexable,
  type PuertosIngesta,
} from "@migue/dominio/ingesta";

const log = createLogger("worker:datos");

/**
 * Bucket del Storage donde el panel deja los documentos.
 *
 * `documentos.ruta_storage` guarda la ruta DENTRO del bucket, no incluye el
 * nombre del bucket. Es la convención que tiene que respetar el panel cuando
 * suba archivos.
 */
const BUCKET = process.env["SUPABASE_BUCKET_DOCUMENTOS"]?.trim() || "documentos";

/** Fila de `documentos` tal como la devuelve PostgREST. */
interface FilaDocumento {
  id: string;
  titulo: string;
  nombre_archivo: string;
  formato: string;
  ruta_storage: string;
}

export function crearPuertos(): PuertosIngesta {
  const supabase = obtenerCliente();

  return {
    async leerDocumento(id: string): Promise<DocumentoARindexar | null> {
      const { data, error } = await supabase
        .from("documentos")
        .select("id, titulo, nombre_archivo, formato, ruta_storage")
        .eq("id", id)
        .maybeSingle<FilaDocumento>();

      if (error) throw new Error(`no pude leer el documento ${id}: ${error.message}`);
      if (data === null) return null;

      return {
        id: data.id,
        titulo: data.titulo,
        nombreArchivo: data.nombre_archivo,
        // El formato de la fila manda, pero si viniera vacío o mal se deduce del
        // nombre. La columna tiene un check, así que esto es un cinturón de
        // seguridad y no una vía habitual.
        formato:
          data.formato === "pdf" ||
          data.formato === "docx" ||
          data.formato === "txt" ||
          data.formato === "md"
            ? data.formato
            : formatoDe(data.nombre_archivo),
        rutaStorage: data.ruta_storage,
      };
    },

    async marcarProcesando(id: string): Promise<void> {
      const { error } = await supabase
        .from("documentos")
        .update({ estado: "procesando", error_detalle: null })
        .eq("id", id);
      if (error) throw new Error(`no pude marcar ${id} como procesando: ${error.message}`);
    },

    async marcarError(id: string, detalle: string): Promise<void> {
      const { error } = await supabase
        .from("documentos")
        // Se recorta porque el detalle puede ser un mensaje largo de una
        // librería y la columna la lee una persona en una tabla del panel.
        .update({ estado: "error", error_detalle: detalle.slice(0, 500) })
        .eq("id", id);
      if (error) log.error({ err: error.message, id }, "no pude registrar el error del documento");
    },

    async descargar(rutaStorage: string): Promise<Uint8Array | null> {
      const { data, error } = await supabase.storage.from(BUCKET).download(rutaStorage);

      if (error) {
        // El Storage devuelve error tanto si el archivo no está como si falló la
        // red, y la diferencia decide si el trabajo se reintenta. «not found» y
        // el 404 son las dos formas en que aparece el archivo ausente.
        const mensaje = error.message.toLowerCase();
        if (mensaje.includes("not found") || mensaje.includes("404")) return null;
        throw new Error(`no pude bajar ${rutaStorage}: ${error.message}`);
      }
      if (data === null) return null;

      return new Uint8Array(await data.arrayBuffer());
    },

    async reemplazarFragmentos(
      documentoId: string,
      fragmentos: readonly FragmentoIndexable[],
      paginas: number,
      hash: string,
    ): Promise<number> {
      // Una sola llamada, y del otro lado una sola transacción: el borrado y la
      // inserción no pueden quedar a medias. Ver `reemplazar_fragmentos` en la
      // migración 016.
      const { data, error } = await supabase.rpc("reemplazar_fragmentos", {
        p_documento_id: documentoId,
        p_fragmentos: fragmentos.map((f) => ({
          orden: f.orden,
          texto: f.texto,
          pagina: f.pagina,
          titulo_seccion: f.tituloSeccion,
          tokens_aprox: f.tokensAprox,
        })),
        p_paginas: paginas,
        p_hash: hash,
      });

      if (error) throw new Error(`no pude guardar los fragmentos: ${error.message}`);
      return typeof data === "number" ? data : 0;
    },

    async borrarDocumento(id: string, rutaStorage: string | null): Promise<void> {
      // Primero el archivo. Si se borrara la fila primero y fallara el Storage,
      // el archivo quedaría sin nadie que sepa que existe: cuota ocupada para
      // siempre.
      if (rutaStorage !== null) {
        const { error } = await supabase.storage.from(BUCKET).remove([rutaStorage]);
        // Un archivo que ya no está no impide borrar la fila.
        if (error) log.warn({ err: error.message, rutaStorage }, "no pude borrar el archivo");
      }

      // Los fragmentos se van por `on delete cascade`.
      const { error } = await supabase.from("documentos").delete().eq("id", id);
      if (error) throw new Error(`no pude borrar el documento ${id}: ${error.message}`);
    },

    async encolarReindexado(): Promise<number> {
      const { data, error } = await supabase.rpc("encolar_reindexado");
      if (error) throw new Error(`no pude encolar el reindexado: ${error.message}`);
      return typeof data === "number" ? data : 0;
    },

    registrar(nivel, mensaje) {
      if (nivel === "error") log.error(mensaje);
      else if (nivel === "aviso") log.warn(mensaje);
      else log.info(mensaje);
    },
  };
}
