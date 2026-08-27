"use client";

import { useState } from "react";
import {
  claveDeStorage,
  descripcionDeError,
  formatoDe,
  mimeDe,
  type Formato,
} from "@migue/dominio/compartido";
import { clienteNavegador } from "@/lib/supabase-navegador";
import { tamanoLegible } from "@/lib/tipos";
import type { Resultado } from "./acciones";

/**
 * 25 MB, que es el `fileSizeLimit` con el que se creó el bucket. Validar acá
 * evita que alguien espere una subida de 40 MB para recibir un error del
 * Storage que no le dice nada.
 */
const MAXIMO_BYTES = 26_214_400;

interface Revision {
  readonly formato: Formato;
  readonly hash: string;
  readonly duplicado: { id: string; titulo: string; activo: boolean } | null;
}

/**
 * Hash SHA-256 en hexadecimal, igual que `hashDe()` del dominio.
 *
 * Tiene que dar EXACTAMENTE lo mismo que el `sha256` de `node:crypto` que usa
 * el worker: es lo que permite detectar que un archivo ya está cargado, y lo que
 * evita chocar contra el índice único `documentos_hash_unico`.
 *
 * `crypto.subtle` sólo existe en contexto seguro (https o localhost). Servido
 * por http en una IP sería `undefined` y la subida no funcionaría: no es un
 * detalle de seguridad, es un requisito funcional, y es la razón por la que el
 * panel necesitaba certificado antes que pantallas.
 */
async function hashDelArchivo(datos: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "Este navegador no expone crypto.subtle. Suele pasar cuando la página se sirve por HTTP " +
        "en vez de HTTPS: sin contexto seguro no se puede calcular el hash del archivo.",
    );
  }
  const resumen = await crypto.subtle.digest("SHA-256", datos);
  return [...new Uint8Array(resumen)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function CajonSubir({
  bucket,
  alCerrar,
  alTerminar,
}: {
  bucket: string;
  alCerrar: () => void;
  alTerminar: (r: Resultado) => void;
}) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [revision, setRevision] = useState<Revision | null>(null);
  const [problema, setProblema] = useState<string | null>(null);
  const [paso, setPaso] = useState<"elegir" | "revisando" | "listo" | "subiendo">("elegir");

  /**
   * Pasos 1 a 3: se valida y se busca duplicado ANTES de tocar el Storage.
   *
   * El chequeo de duplicado es lo que evita mostrarle a un operador un
   * «duplicate key value violates unique constraint documentos_hash_unico».
   */
  async function revisar(f: File) {
    setProblema(null);
    setRevision(null);
    setArchivo(f);
    setTitulo(f.name.replace(/\.[^.]+$/, ""));
    setPaso("revisando");

    try {
      let formato: Formato;
      try {
        formato = formatoDe(f.name);
      } catch (error) {
        // `formatoDe` ya trae el mensaje explicando qué se admite y qué hacer
        // con un escaneo.
        throw new Error(descripcionDeError(error));
      }

      if (f.size === 0) throw new Error("El archivo está vacío.");
      if (f.size > MAXIMO_BYTES) {
        throw new Error(
          `Pesa ${tamanoLegible(f.size)} y el máximo son ${tamanoLegible(MAXIMO_BYTES)}.`,
        );
      }

      const hash = await hashDelArchivo(await f.arrayBuffer());

      const supabase = clienteNavegador();
      const { data, error } = await supabase
        .from("documentos")
        .select("id, titulo, activo")
        .eq("hash_sha256", hash)
        .maybeSingle();

      if (error) throw new Error(`No pude revisar si ya estaba cargado: ${error.message}`);

      setRevision({
        formato,
        hash,
        duplicado: data ? { id: data.id, titulo: data.titulo, activo: data.activo } : null,
      });
      setPaso("listo");
    } catch (error) {
      setProblema(descripcionDeError(error));
      setPaso("elegir");
    }
  }

  /**
   * Pasos 4 a 7. El orden no es negociable:
   *
   *   Storage primero, después la fila. Al revés, si falla la subida queda una
   *   fila apuntando a un archivo que no existe y el worker contesta «no se
   *   encontró el archivo en el Storage». Así, lo peor que queda es un archivo
   *   huérfano que el próximo intento sobreescribe, porque la clave lleva el
   *   hash y la subida es idempotente.
   *
   *   Los pasos 6 y 7 son dos llamadas y no son atómicas. Si falla la 7, el
   *   documento queda «en cola» sin trabajo que lo levante. No se arma una
   *   transacción para eso: lo recupera el botón Reintentar del listado, que es
   *   el mismo camino de código.
   */
  async function confirmar() {
    if (!archivo || !revision) return;
    setPaso("subiendo");
    setProblema(null);

    try {
      const supabase = clienteNavegador();
      const { data: sesion } = await supabase.auth.getUser();
      const usuarioId = sesion.user?.id ?? null;

      const ruta = claveDeStorage(archivo.name, revision.hash);

      const { error: errorSubida } = await supabase.storage.from(bucket).upload(ruta, archivo, {
        contentType: mimeDe(revision.formato),
        upsert: true,
      });
      if (errorSubida) {
        throw new Error(
          errorSubida.message.includes("row-level security")
            ? "El Storage rechazó la subida por permisos. Falta aplicar las políticas del bucket (migración 018)."
            : `No se pudo subir el archivo: ${errorSubida.message}`,
        );
      }

      const { data: doc, error: errorFila } = await supabase
        .from("documentos")
        .insert({
          titulo: titulo.trim(),
          descripcion: descripcion.trim() || null,
          // El nombre ORIGINAL, con acentos: es lo que el extractor usa en sus
          // mensajes de error, que después lee alguien del área.
          nombre_archivo: archivo.name,
          formato: revision.formato,
          ruta_storage: ruta,
          bytes: archivo.size,
          hash_sha256: revision.hash,
          estado: "pendiente",
          subido_por: usuarioId,
        })
        .select("id")
        .single();

      if (errorFila) throw new Error(`Se subió el archivo pero no pude registrarlo: ${errorFila.message}`);

      const { error: errorCola } = await supabase.from("trabajos").insert({
        tipo: "ingestar_documento",
        payload: { documento_id: doc.id },
        // 50 y no el default 100: hay alguien mirando la pantalla. El
        // reindexado masivo va en 200.
        prioridad: 50,
        creado_por: usuarioId,
      });

      if (errorCola) {
        alTerminar({
          ok: false,
          mensaje:
            "El documento quedó cargado pero no se pudo encolar su lectura. " +
            "Usá «Reintentar» en la lista.",
        });
        return;
      }

      alTerminar({
        ok: true,
        mensaje: `«${titulo.trim()}» subido. Migue lo va a poder citar en unos segundos.`,
      });
    } catch (error) {
      setProblema(descripcionDeError(error));
      setPaso("listo");
    }
  }

  const duplicado = revision?.duplicado ?? null;
  const subiendo = paso === "subiendo";
  const puedeConfirmar = paso === "listo" && titulo.trim() !== "" && !duplicado;

  return (
    <>
      <div className="velo" onClick={alCerrar} aria-hidden="true" />
      <aside className="cajon" role="dialog" aria-label="Subir documento" aria-modal="true">
        <div className="cajon-cabecera">
          <h2>Subir documento</h2>
          <button className="chico" onClick={alCerrar} aria-label="Cerrar">
            Cerrar
          </button>
        </div>

        <div className="cajon-cuerpo">
          <div className="campo">
            <label htmlFor="archivo">Archivo</label>
            <input
              id="archivo"
              type="file"
              accept=".pdf,.docx,.txt,.md"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void revisar(f);
              }}
            />
            <p className="ayuda">
              PDF, DOCX, TXT o MD, hasta {tamanoLegible(MAXIMO_BYTES)}. Un PDF escaneado no
              sirve: son imágenes de páginas y no tienen texto que leer.
            </p>
          </div>

          {paso === "revisando" && <div className="aviso info">Revisando el archivo…</div>}

          {problema && (
            <div className="aviso mal" role="alert">
              {problema}
            </div>
          )}

          {duplicado && (
            <div className="aviso atencion">
              Ese archivo ya está cargado como <strong>«{duplicado.titulo}»</strong>
              {duplicado.activo
                ? "."
                : ", dado de baja. Si lo querés usar de nuevo, reactivalo desde la lista en vez de subirlo otra vez."}
            </div>
          )}

          {revision && !duplicado && (
            <div className="aviso ok">
              {revision.formato.toUpperCase()} de {tamanoLegible(archivo?.size ?? 0)}, sin
              duplicados. Listo para subir.
            </div>
          )}

          <div className="campo">
            <label htmlFor="titulo">Título</label>
            <input
              id="titulo"
              type="text"
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder="Programa CONTROLÁ — Plan Rector 2023-2030"
            />
            <p className="ayuda">
              Así lo va a nombrar Migue cuando cite este documento a un vecino. Conviene que se
              entienda sin contexto.
            </p>
          </div>

          <div className="campo">
            <label htmlFor="descripcion">Descripción (opcional)</label>
            <textarea
              id="descripcion"
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              placeholder="Para uso interno del panel. Migue no la lee."
            />
          </div>
        </div>

        <div className="cajon-pie">
          <button onClick={alCerrar}>Cancelar</button>
          <button
            className="primario"
            disabled={!puedeConfirmar || subiendo}
            onClick={() => void confirmar()}
          >
            {subiendo ? "Subiendo…" : "Subir"}
          </button>
        </div>
      </aside>
    </>
  );
}
