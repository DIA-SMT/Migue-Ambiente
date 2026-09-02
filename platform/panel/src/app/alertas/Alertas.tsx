"use client";

/**
 * La cola de pedidos de asesor.
 *
 * Refresca sola cada 15 segundos MIENTRAS está abierta: acá «tiempo real» es
 * polling, coherente con la decisión escrita del proyecto contra Realtime
 * (worker/bucle.ts) — para devolver un llamado, 15 segundos de latencia
 * alcanzan y sobran, y no agregan un websocket que pueda fallar distinto.
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fechaLegible, type AlertaAsesor } from "@/lib/tipos";
import { haceCuanto } from "@/lib/metricas";
import { atenderAlerta, type Resultado } from "./acciones";

const REFRESCO_MS = 15_000;

type Filtro = "pendientes" | "todas";

export function Alertas({
  alertas,
  atendidoPor,
}: {
  alertas: AlertaAsesor[];
  /** usuario_id → nombre, resuelto en el servidor con personal_nombres(). */
  atendidoPor: Record<string, string>;
}) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const [filtro, setFiltro] = useState<Filtro>("pendientes");
  const [aviso, setAviso] = useState<Resultado | null>(null);
  const [confirmandoDescarte, setConfirmandoDescarte] = useState<string | null>(null);

  // `ahora` en estado y no en el render: el «hace 5 minutos» del servidor y el
  // del navegador diferirían y React avisaría de la discrepancia de hidratación.
  const [ahora, setAhora] = useState<number | null>(null);
  useEffect(() => setAhora(Date.now()), [alertas]);

  // El refresco de la página completa está bien ACÁ (la lista ES el contenido);
  // el badge de la barra hace su propio conteo sin recargar nada.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, REFRESCO_MS);
    return () => clearInterval(timer);
  }, [router]);

  const pendientes = useMemo(() => alertas.filter((a) => a.estado === "pendiente"), [alertas]);
  const visibles = filtro === "pendientes" ? pendientes : alertas;

  function resolver(id: string, estado: "atendida" | "descartada" | "pendiente") {
    setConfirmandoDescarte(null);
    empezar(async () => {
      setAviso(await atenderAlerta(id, estado));
      router.refresh();
    });
  }

  return (
    <>
      {aviso && (
        <div className={`aviso ${aviso.ok ? "ok" : "mal"}`} role="status">
          {aviso.mensaje}
        </div>
      )}

      <div className="resumen">
        <div>
          <span className="n" style={{ color: pendientes.length > 0 ? "var(--alerta)" : undefined }}>
            {pendientes.length}
          </span>
          <span className="r">esperando</span>
        </div>
        <div>
          <span className="n">{alertas.length}</span>
          <span className="r">en total</span>
        </div>
      </div>

      <div className="pestanas" role="tablist">
        <button
          role="tab"
          aria-selected={filtro === "pendientes"}
          className={filtro === "pendientes" ? "activa" : ""}
          onClick={() => setFiltro("pendientes")}
        >
          Pendientes
          <span className="cuenta">{pendientes.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={filtro === "todas"}
          className={filtro === "todas" ? "activa" : ""}
          onClick={() => setFiltro("todas")}
        >
          Todas
          <span className="cuenta">{alertas.length}</span>
        </button>
      </div>

      {visibles.length === 0 ? (
        <div className="tarjeta vacio">
          {filtro === "pendientes"
            ? "Nadie está esperando un asesor en este momento."
            : "Todavía ningún vecino pidió hablar con una persona."}
        </div>
      ) : (
        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th>Vecino</th>
                <th>Teléfono</th>
                <th>Qué contó</th>
                <th>Cuándo</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.nombre_usuario ?? "—"}
                    <div className="sub-fila">{a.canal}</div>
                  </td>
                  <td>
                    {a.telefono ? (
                      <span className="sub-fila">{a.telefono}</span>
                    ) : (
                      <span title="No quiso dar teléfono: la respuesta le llega por el chat del bot">
                        por el chat
                      </span>
                    )}
                  </td>
                  <td style={{ maxWidth: 300 }}>{a.motivo ?? "—"}</td>
                  <td title={fechaLegible(a.creado_en, true)}>
                    {ahora === null ? "—" : haceCuanto(ahora - new Date(a.creado_en).getTime())}
                  </td>
                  <td>
                    {a.estado === "pendiente" ? (
                      <span className="chip alerta">esperando</span>
                    ) : a.estado === "atendida" ? (
                      <span className="chip ok" title={a.atendida_en ? fechaLegible(a.atendida_en, true) : undefined}>
                        atendida{a.atendida_por ? ` · ${atendidoPor[a.atendida_por] ?? "—"}` : ""}
                      </span>
                    ) : (
                      <span className="chip pend">descartada</span>
                    )}
                    {a.notas && <div className="sub-fila">{a.notas}</div>}
                  </td>
                  <td>
                    {a.estado === "pendiente" ? (
                      confirmandoDescarte === a.id ? (
                        <>
                          <button
                            className="boton chico peligro"
                            disabled={pendiente}
                            onClick={() => resolver(a.id, "descartada")}
                          >
                            Sí, descartar
                          </button>
                          <button
                            className="boton chico"
                            onClick={() => setConfirmandoDescarte(null)}
                          >
                            No
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="boton chico"
                            disabled={pendiente}
                            onClick={() => resolver(a.id, "atendida")}
                          >
                            Marcar atendida
                          </button>
                          <button
                            className="boton chico"
                            disabled={pendiente}
                            onClick={() => setConfirmandoDescarte(a.id)}
                          >
                            Descartar
                          </button>
                        </>
                      )
                    ) : (
                      <button
                        className="boton chico"
                        disabled={pendiente}
                        onClick={() => resolver(a.id, "pendiente")}
                      >
                        Reabrir
                      </button>
                    )}
                    {a.conversacion_id && (
                      /* El circuito ?abrir= ya existe: Clima lo usa igual. Busca
                         entre las últimas 200 conversaciones; para una alerta
                         reciente siempre está. */
                      <Link className="boton chico" href={`/conversaciones?abrir=${a.conversacion_id}`}>
                        Ver conversación
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
