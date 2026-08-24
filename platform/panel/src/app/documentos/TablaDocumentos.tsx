"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  estadoVisible,
  fechaLegible,
  tamanoLegible,
  type Documento,
} from "@/lib/tipos";
import { borrar, cambiarActivo, reintentar, urlDeDescarga, type Resultado } from "./acciones";
import { CajonSubir } from "./CajonSubir";

/**
 * Cada cuánto se vuelve a consultar mientras hay algo en curso.
 *
 * Tres segundos porque es lo que tarda el worker en volver a mirar la cola
 * (ESPERA_VACIA en worker/bucle.ts). Pedir más seguido no hace que aparezca
 * antes; sólo gasta consultas.
 */
const ESPERA_MS = 3_000;

export function TablaDocumentos({
  documentos,
  nombres,
  bucket,
}: {
  documentos: Documento[];
  nombres: Record<string, string>;
  bucket: string;
}) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const [aviso, setAviso] = useState<Resultado | null>(null);
  const [mostrarBajas, setMostrarBajas] = useState(false);
  const [abrirSubir, setAbrirSubir] = useState(false);
  const [confirmandoBorrado, setConfirmandoBorrado] = useState<string | null>(null);

  // `ahora` en estado y no `Date.now()` directo: si se leyera en el render, el
  // servidor y el navegador calcularían distinto el «parece colgado» y React
  // avisaría de una discrepancia de hidratación.
  const [ahora, setAhora] = useState<number | null>(null);
  useEffect(() => setAhora(Date.now()), [documentos]);

  const enCurso = documentos.some((d) => d.estado === "pendiente" || d.estado === "procesando");

  // Se consulta de nuevo SÓLO mientras haya algo en curso. Con todo terminado,
  // el panel no habla con la base.
  useEffect(() => {
    if (!enCurso) return;
    const t = setInterval(() => router.refresh(), ESPERA_MS);
    return () => clearInterval(t);
  }, [enCurso, router]);

  const visibles = mostrarBajas ? documentos : documentos.filter((d) => d.activo);
  const ocultos = documentos.length - visibles.length;

  function ejecutar(accion: () => Promise<Resultado>) {
    empezar(async () => {
      setAviso(await accion());
      setConfirmandoBorrado(null);
      router.refresh();
    });
  }

  async function descargar(ruta: string) {
    const url = await urlDeDescarga(ruta);
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

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <label style={{ display: "flex", gap: 7, alignItems: "center", margin: 0, fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={mostrarBajas}
            onChange={(e) => setMostrarBajas(e.target.checked)}
            style={{ width: "auto" }}
          />
          Mostrar los dados de baja{ocultos > 0 && !mostrarBajas ? ` (${ocultos})` : ""}
        </label>

        <button className="primario" onClick={() => setAbrirSubir(true)}>
          Subir documento
        </button>
      </div>

      {visibles.length === 0 ? (
        <div className="tarjeta vacio">
          {documentos.length === 0
            ? "Todavía no hay documentos cargados."
            : "Todos los documentos están dados de baja."}
        </div>
      ) : (
        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th>Documento</th>
                <th>Estado</th>
                <th className="num">Págs.</th>
                <th className="num">Tamaño</th>
                <th>Actualizado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((d) => {
                const e = estadoVisible(d, ahora ?? new Date(d.actualizado_en).getTime());
                return (
                  <tr key={d.id} className={d.activo ? undefined : "de-baja"}>
                    <td>
                      <Link href={`/documentos/${d.id}`} className="titulo-fila">
                        {d.titulo}
                      </Link>
                      <div className="sub-fila">
                        {d.formato.toUpperCase()} · {d.nombre_archivo}
                      </div>
                      {e.detalle && <div className="detalle-problema">{e.detalle}</div>}
                    </td>

                    <td>
                      <span className={`chip ${e.tono}`}>{e.etiqueta}</span>
                      {!d.activo && (
                        <div className="sub-fila" style={{ marginTop: 4 }}>
                          dado de baja
                        </div>
                      )}
                    </td>

                    <td className="num">{d.paginas ?? "—"}</td>
                    <td className="num">{tamanoLegible(d.bytes)}</td>
                    <td>
                      {fechaLegible(d.actualizado_en)}
                      {d.subido_por && nombres[d.subido_por] && (
                        <div className="sub-fila">{nombres[d.subido_por]}</div>
                      )}
                    </td>

                    <td>
                      <div className="acciones">
                        <button
                          className="chico"
                          disabled={pendiente}
                          onClick={() => ejecutar(() => cambiarActivo(d.id, !d.activo))}
                          title={
                            d.activo
                              ? "Migue deja de citarlo ahora mismo"
                              : "Migue vuelve a poder citarlo"
                          }
                        >
                          {d.activo ? "Dar de baja" : "Reactivar"}
                        </button>

                        {e.reintentable && (
                          <button
                            className="chico"
                            disabled={pendiente}
                            onClick={() => ejecutar(() => reintentar(d.id))}
                          >
                            Reintentar
                          </button>
                        )}

                        <button className="chico" onClick={() => void descargar(d.ruta_storage)}>
                          Descargar
                        </button>

                        {confirmandoBorrado === d.id ? (
                          <>
                            <button
                              className="chico peligro"
                              disabled={pendiente}
                              onClick={() => ejecutar(() => borrar(d.id))}
                            >
                              Confirmar borrado
                            </button>
                            <button className="chico" onClick={() => setConfirmandoBorrado(null)}>
                              No
                            </button>
                          </>
                        ) : (
                          <button
                            className="chico peligro"
                            onClick={() => setConfirmandoBorrado(d.id)}
                          >
                            Borrar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {enCurso && (
        <p className="ayuda" style={{ marginTop: 10 }}>
          Hay documentos en proceso. La pantalla se actualiza sola cada 3 segundos.
        </p>
      )}

      {abrirSubir && (
        <CajonSubir
          bucket={bucket}
          alCerrar={() => setAbrirSubir(false)}
          alTerminar={(r) => {
            setAviso(r);
            setAbrirSubir(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
