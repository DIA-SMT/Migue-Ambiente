"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  datosFaltantes,
  esEstadoHeredado,
  estaCerrado,
  ESTADOS_PROGRAMA,
  ESTADOS_TICKET,
  fechaLegible,
  situacionSla,
  type SolicitudPrograma,
  type Ticket,
} from "@/lib/tipos";
import { cambiarEstado, type Resultado } from "./acciones";
import { FichaCaso } from "./FichaCaso";

type Filtro = "abiertos" | "vencidos" | "todos";

export function Casos({
  tickets,
  solicitudes,
}: {
  tickets: Ticket[];
  solicitudes: SolicitudPrograma[];
}) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const [pestana, setPestana] = useState<"tickets" | "programas">("tickets");
  const [filtro, setFiltro] = useState<Filtro>("abiertos");
  const [aviso, setAviso] = useState<Resultado | null>(null);
  const [abierto, setAbierto] = useState<Ticket | SolicitudPrograma | null>(null);

  // `ahora` en estado y no leído en el render: el servidor y el navegador
  // calcularían distinto el vencimiento y React avisaría de una discrepancia de
  // hidratación.
  const [ahora, setAhora] = useState<number | null>(null);
  useEffect(() => setAhora(Date.now()), [tickets]);

  const ordenados = useMemo(() => {
    if (ahora === null) return tickets;
    return [...tickets].sort((a, b) => {
      const ua = situacionSla(a, ahora).urgencia;
      const ub = situacionSla(b, ahora).urgencia;
      if (ua !== ub) return ua - ub;
      // A igual urgencia, el más viejo primero: lleva más tiempo esperando.
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  }, [tickets, ahora]);

  const visibles = useMemo(() => {
    if (filtro === "todos") return ordenados;
    if (filtro === "vencidos") {
      return ordenados.filter(
        (t) => !estaCerrado(t) && situacionSla(t, ahora ?? Date.now()).urgencia === 0,
      );
    }
    return ordenados.filter((t) => !estaCerrado(t));
  }, [ordenados, filtro, ahora]);

  const abiertos = tickets.filter((t) => !estaCerrado(t)).length;
  const vencidos =
    ahora === null
      ? 0
      : tickets.filter((t) => !estaCerrado(t) && situacionSla(t, ahora).urgencia === 0).length;
  const programasAbiertos = solicitudes.filter((s) => !estaCerrado(s)).length;

  function mover(tabla: "tickets" | "program_requests", id: string, estado: string) {
    empezar(async () => {
      setAviso(await cambiarEstado(tabla, id, estado));
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
          <span className="n">{abiertos}</span>
          <span className="r">abiertos</span>
        </div>
        <div>
          <span className="n" style={{ color: vencidos > 0 ? "var(--alerta)" : undefined }}>
            {ahora === null ? "—" : vencidos}
          </span>
          <span className="r">con el plazo vencido</span>
        </div>
        <div>
          <span className="n">{programasAbiertos}</span>
          <span className="r">solicitudes de programas</span>
        </div>
      </div>

      <div className="pestanas" role="tablist">
        <button
          role="tab"
          aria-selected={pestana === "tickets"}
          className={pestana === "tickets" ? "activa" : ""}
          onClick={() => setPestana("tickets")}
        >
          Retiros y reclamos
          <span className="cuenta">{tickets.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={pestana === "programas"}
          className={pestana === "programas" ? "activa" : ""}
          onClick={() => setPestana("programas")}
        >
          Programas
          <span className="cuenta">{solicitudes.length}</span>
        </button>
      </div>

      {pestana === "tickets" ? (
        <>
          <div style={{ display: "flex", gap: 6, margin: "16px 0 12px", flexWrap: "wrap" }}>
            {(
              [
                ["abiertos", `Abiertos (${abiertos})`],
                ["vencidos", `Vencidos (${ahora === null ? "—" : vencidos})`],
                ["todos", `Todos (${tickets.length})`],
              ] as const
            ).map(([valor, texto]) => (
              <button
                key={valor}
                className={filtro === valor ? "primario chico" : "chico"}
                onClick={() => setFiltro(valor)}
              >
                {texto}
              </button>
            ))}
          </div>

          {visibles.length === 0 ? (
            <div className="tarjeta vacio">
              {filtro === "vencidos"
                ? "Nada vencido. Buena señal."
                : filtro === "abiertos"
                  ? "No hay casos abiertos."
                  : "Todavía no hay pedidos ni reclamos."}
            </div>
          ) : (
            <div className="envoltorio-tabla tarjeta">
              <table>
                <thead>
                  <tr>
                    <th>Plazo</th>
                    <th>Caso</th>
                    <th>Dirección</th>
                    <th>Estado</th>
                    <th>Entró</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((t) => {
                    const s = situacionSla(t, ahora ?? new Date(t.created_at).getTime());
                    const faltan = datosFaltantes(t);
                    return (
                      <tr key={t.id}>
                        <td>
                          <span className={`chip ${s.tono}`}>{s.etiqueta}</span>
                        </td>
                        <td>
                          <button
                            className="enlace-tabla"
                            onClick={() => setAbierto(t)}
                            title="Ver la ficha completa"
                          >
                            {t.ticket_type}
                          </button>
                          <div className="sub-fila">
                            {[t.waste_type, t.quantity].filter(Boolean).join(" · ") || "—"}
                          </div>
                          {t.exceeds_limit && (
                            <span className="chip curso" style={{ marginTop: 4 }}>
                              excede el límite
                            </span>
                          )}
                          {faltan.length > 0 && (
                            <div className="detalle-problema">Falta: {faltan.join(", ")}</div>
                          )}
                        </td>
                        <td style={{ maxWidth: 220 }}>{t.address ?? "—"}</td>
                        <td>
                          <span className={esEstadoHeredado(t.status) ? "chip pend" : "chip ok"}>
                            {t.status}
                          </span>
                          {esEstadoHeredado(t.status) && (
                            <div className="sub-fila" style={{ marginTop: 3 }}>
                              del bot anterior
                            </div>
                          )}
                        </td>
                        <td>{fechaLegible(t.created_at)}</td>
                        <td>
                          <div className="acciones">
                            <select
                              value=""
                              disabled={pendiente}
                              onChange={(e) => {
                                if (e.target.value) mover("tickets", t.id, e.target.value);
                              }}
                              style={{ width: "auto", padding: "4px 8px", fontSize: "0.82rem" }}
                              aria-label="Mover a"
                            >
                              <option value="">Mover a…</option>
                              {ESTADOS_TICKET.filter((x) => x !== t.status).map((x) => (
                                <option key={x} value={x}>
                                  {x}
                                </option>
                              ))}
                            </select>
                            <button className="chico" onClick={() => setAbierto(t)}>
                              Abrir
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div style={{ marginTop: 16 }}>
          {solicitudes.length === 0 ? (
            <div className="tarjeta vacio">Todavía no hay solicitudes de programas.</div>
          ) : (
            <div className="envoltorio-tabla tarjeta">
              <table>
                <thead>
                  <tr>
                    <th>Programa</th>
                    <th>Institución</th>
                    <th>Contacto</th>
                    <th>Estado</th>
                    <th>Entró</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {solicitudes.map((s) => (
                    <tr key={s.id} className={estaCerrado(s) ? "de-baja" : undefined}>
                      <td>
                        <button className="enlace-tabla" onClick={() => setAbierto(s)}>
                          {s.program_type.toUpperCase()}
                        </button>
                        {s.student_count !== null && (
                          <div className="sub-fila">{s.student_count} personas</div>
                        )}
                      </td>
                      <td style={{ maxWidth: 220 }}>
                        {s.institution_name ?? "—"}
                        {s.address && <div className="sub-fila">{s.address}</div>}
                      </td>
                      <td>
                        {s.responsible_person ?? "—"}
                        {s.contact_phone && <div className="sub-fila">{s.contact_phone}</div>}
                      </td>
                      <td>
                        <span className="chip ok">{s.status}</span>
                      </td>
                      <td>{fechaLegible(s.created_at)}</td>
                      <td>
                        <div className="acciones">
                          <select
                            value=""
                            disabled={pendiente}
                            onChange={(e) => {
                              if (e.target.value) mover("program_requests", s.id, e.target.value);
                            }}
                            style={{ width: "auto", padding: "4px 8px", fontSize: "0.82rem" }}
                            aria-label="Mover a"
                          >
                            <option value="">Mover a…</option>
                            {ESTADOS_PROGRAMA.filter((x) => x !== s.status).map((x) => (
                              <option key={x} value={x}>
                                {x}
                              </option>
                            ))}
                          </select>
                          <button className="chico" onClick={() => setAbierto(s)}>
                            Abrir
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {abierto && (
        <FichaCaso
          caso={abierto}
          alCerrar={() => setAbierto(null)}
          alCambiar={(r) => {
            setAviso(r);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
