"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { editarMetadatos, reintentar, cambiarActivo, urlDeDescarga, type Resultado } from "../acciones";
import type { Documento } from "@/lib/tipos";

/**
 * Título, descripción y las acciones del documento.
 *
 * Editar el título y la descripción NO requiere reindexar: no cambia el
 * contenido. Pero el título sí cambia lo que el vecino ve, porque
 * `armarContexto` se lo pasa al modelo como etiqueta de la fuente.
 */
export function Metadatos({ documento }: { documento: Documento }) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const [editando, setEditando] = useState(false);
  const [titulo, setTitulo] = useState(documento.titulo);
  const [descripcion, setDescripcion] = useState(documento.descripcion ?? "");
  const [aviso, setAviso] = useState<Resultado | null>(null);

  function ejecutar(accion: () => Promise<Resultado>, alTerminar?: () => void) {
    empezar(async () => {
      setAviso(await accion());
      alTerminar?.();
      router.refresh();
    });
  }

  async function descargar() {
    const url = await urlDeDescarga(documento.ruta_storage);
    if (url) window.open(url, "_blank", "noopener");
    else setAviso({ ok: false, mensaje: "No pude generar el enlace de descarga." });
  }

  return (
    <>
      {aviso && (
        <div className={`aviso ${aviso.ok ? "ok" : "mal"}`} role="status">
          {aviso.mensaje}
        </div>
      )}

      {editando ? (
        <div className="tarjeta" style={{ padding: 18 }}>
          <div className="campo">
            <label htmlFor="t">Título</label>
            <input id="t" type="text" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
            <p className="ayuda">Así lo nombra Migue cuando cita este documento a un vecino.</p>
          </div>
          <div className="campo">
            <label htmlFor="d">Descripción</label>
            <textarea id="d" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
            <p className="ayuda">Sólo para el panel. Migue no la lee.</p>
          </div>
          <div className="acciones">
            <button
              className="primario"
              disabled={pendiente || titulo.trim() === ""}
              onClick={() =>
                ejecutar(
                  () => editarMetadatos(documento.id, titulo, descripcion),
                  () => setEditando(false),
                )
              }
            >
              Guardar
            </button>
            <button
              onClick={() => {
                setTitulo(documento.titulo);
                setDescripcion(documento.descripcion ?? "");
                setEditando(false);
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <>
          {documento.descripcion && (
            <p className="bajada" style={{ marginBottom: 14 }}>
              {documento.descripcion}
            </p>
          )}
          <div className="acciones">
            <button onClick={() => setEditando(true)}>Editar título y descripción</button>
            <button disabled={pendiente} onClick={() => ejecutar(() => reintentar(documento.id))}>
              Volver a leer el archivo
            </button>
            <button
              disabled={pendiente}
              onClick={() => ejecutar(() => cambiarActivo(documento.id, !documento.activo))}
            >
              {documento.activo ? "Dar de baja" : "Reactivar"}
            </button>
            <button onClick={() => void descargar()}>Descargar original</button>
          </div>
        </>
      )}
    </>
  );
}
