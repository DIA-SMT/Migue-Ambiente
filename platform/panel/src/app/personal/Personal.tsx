"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  fechaLegible,
  LO_QUE_NO_SE_PUEDE,
  porQueNoSePuedeEditar,
  ROLES_PANEL,
  type CuentaSinPadron,
  type Persona,
  type RolPanel,
} from "@/lib/tipos";
import {
  cambiarEstado,
  cambiarRol,
  cuentasSinPadron,
  darDeAlta,
  type Resultado,
} from "./acciones";

/**
 * El padrón del panel.
 *
 * Dos decisiones de interfaz que vienen de cómo se rompe esto:
 *
 * 1. Los controles de TU PROPIA línea están deshabilitados, con el motivo al
 *    lado. La base ya lo impide con un trigger, pero dejar el botón activo para
 *    que falle con un error de Postgres es peor que explicarlo antes.
 *
 * 2. El alta es en dos pasos y el primero es leer, no escribir: se listan las
 *    cuentas de Supabase que todavía no están en el padrón y se elige una. No
 *    hay un campo de correo libre, porque escribir un correo que no existe en
 *    `auth.users` da un error de clave foránea que no le dice nada a nadie.
 */
/**
 * El enlace directo a la pantalla de Supabase donde se crea la cuenta.
 *
 * Se arma del `NEXT_PUBLIC_SUPABASE_URL`, que ya viaja al navegador: la URL del
 * proyecto es `https://<ref>.supabase.co` y el tablero vive en
 * `dashboard/project/<ref>/auth/users`.
 *
 * Existe porque «andá a Supabase → Authentication → Users → Add user» escrito en
 * prosa obliga a alguien que entra dos veces por año a buscar cuatro pantallas.
 * Si el formato de la URL cambiara, devuelve null y el texto queda igual de
 * correcto, sólo que sin atajo.
 */
function enlaceASupabase(): string | null {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(url)?.[1];
  return ref ? `https://supabase.com/dashboard/project/${ref}/auth/users` : null;
}

export function Personal({
  padron,
  yoSoy,
  esAdmin,
}: {
  padron: Persona[];
  yoSoy: string;
  esAdmin: boolean;
}) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const [aviso, setAviso] = useState<Resultado | null>(null);
  const [confirmandoBaja, setConfirmandoBaja] = useState<string | null>(null);

  // El alta
  const [abierto, setAbierto] = useState(false);
  const [cuentas, setCuentas] = useState<CuentaSinPadron[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [elegida, setElegida] = useState<CuentaSinPadron | null>(null);
  const [nombre, setNombre] = useState("");
  const [rol, setRol] = useState<RolPanel>("operador");
  const [notas, setNotas] = useState("");

  function ejecutar(accion: () => Promise<Resultado>) {
    empezar(async () => {
      setAviso(await accion());
      setConfirmandoBaja(null);
      router.refresh();
    });
  }

  async function abrirAlta() {
    setAbierto(true);
    setElegida(null);
    setNombre("");
    setRol("operador");
    setNotas("");
    setCargando(true);
    const r = await cuentasSinPadron();
    setCuentas(r.ok ? r.cuentas : []);
    if (!r.ok) setAviso(r);
    setCargando(false);
  }

  const activos = padron.filter((p) => p.activo);
  const admins = activos.filter((p) => p.rol === "admin");

  return (
    <>
      {aviso && (
        <div className={`aviso ${aviso.ok ? "ok" : "mal"}`} role="status">
          {aviso.mensaje}
        </div>
      )}

      {/* El riesgo estructural: con un solo admin, si esa persona pierde el
          acceso por fuera del panel —una cuenta borrada en Supabase— no queda
          nadie que pueda arreglarlo desde acá. */}
      {esAdmin && admins.length === 1 && (
        <div className="aviso atencion">
          <strong>Hay un solo administrador.</strong>
          <div style={{ marginTop: 6 }}>
            Si esa cuenta se pierde —se borra en Supabase, o alguien deja el área— nadie va a poder
            administrar el padrón desde el panel y habrá que arreglarlo por SQL. Conviene que haya
            al menos dos.
          </div>
        </div>
      )}

      {esAdmin && (
        <div style={{ margin: "18px 0 14px" }}>
          <button className="primario" onClick={() => void abrirAlta()}>
            Dar acceso a alguien
          </button>
        </div>
      )}

      {padron.length === 0 ? (
        <div className="tarjeta vacio">No hay nadie en el padrón.</div>
      ) : (
        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th>Persona</th>
                <th>Puede</th>
                <th>Estado</th>
                <th>Último cambio</th>
                {esAdmin && <th>Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {padron.map((p) => {
                const bloqueo = porQueNoSePuedeEditar(p, yoSoy);
                const info = ROLES_PANEL[p.rol];
                return (
                  <tr key={p.usuario_id} className={p.activo ? undefined : "de-baja"}>
                    <td>
                      <div className="titulo-fila">
                        {p.nombre ?? p.correo}
                        {p.usuario_id === yoSoy && (
                          <span className="chip pend" style={{ marginLeft: 8 }}>
                            sos vos
                          </span>
                        )}
                      </div>
                      <div className="sub-fila">{p.correo}</div>
                      {p.notas && <div className="sub-fila">{p.notas}</div>}
                    </td>

                    <td style={{ maxWidth: 300 }}>
                      <span className={`chip ${info.tono}`}>{info.rotulo}</span>
                      <div className="ayuda" style={{ marginTop: 4 }}>
                        {info.puede}
                      </div>
                    </td>

                    <td>
                      <span className={`chip ${p.activo ? "ok" : "pend"}`}>
                        {p.activo ? "puede entrar" : "sin acceso"}
                      </span>
                    </td>

                    <td>
                      <div>{fechaLegible(p.actualizado_en)}</div>
                      <div className="sub-fila">alta: {fechaLegible(p.creado_en)}</div>
                    </td>

                    {esAdmin && (
                      <td>
                        {bloqueo !== null ? (
                          <div className="detalle-problema" style={{ maxWidth: 280 }}>
                            {bloqueo}
                          </div>
                        ) : (
                          <div className="acciones">
                            <select
                              value={p.rol}
                              disabled={pendiente}
                              onChange={(e) =>
                                ejecutar(() => cambiarRol(p.usuario_id, e.target.value as RolPanel))
                              }
                              style={{ width: "auto", padding: "4px 8px", fontSize: "0.82rem" }}
                              aria-label={`Rol de ${p.nombre ?? p.correo}`}
                            >
                              {(Object.keys(ROLES_PANEL) as RolPanel[]).map((r) => (
                                <option key={r} value={r}>
                                  {ROLES_PANEL[r].rotulo}
                                </option>
                              ))}
                            </select>

                            {p.activo ? (
                              confirmandoBaja === p.usuario_id ? (
                                <>
                                  <button
                                    className="chico peligro"
                                    disabled={pendiente}
                                    onClick={() =>
                                      ejecutar(() => cambiarEstado(p.usuario_id, false))
                                    }
                                  >
                                    Confirmar baja
                                  </button>
                                  <button
                                    className="chico"
                                    onClick={() => setConfirmandoBaja(null)}
                                  >
                                    No
                                  </button>
                                </>
                              ) : (
                                <button
                                  className="chico peligro"
                                  onClick={() => setConfirmandoBaja(p.usuario_id)}
                                >
                                  Dar de baja
                                </button>
                              )
                            ) : (
                              <button
                                className="chico"
                                disabled={pendiente}
                                onClick={() => ejecutar(() => cambiarEstado(p.usuario_id, true))}
                              >
                                Reactivar
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------- lo que no se puede --- */}

      <section style={{ marginTop: 32 }}>
        <h2>Lo que esta pantalla no hace</h2>
        <p className="bajada" style={{ marginTop: 4 }}>
          Está acá para que nadie busque un botón que no existe, y para que una de estas cuatro no
          se aprenda rompiendo algo.
        </p>
        {LO_QUE_NO_SE_PUEDE.map((x) => (
          <div key={x.que} className="tarjeta" style={{ padding: 14, marginBottom: 10 }}>
            <div className="titulo-fila">{x.que}</div>
            <p className="ayuda" style={{ maxWidth: "78ch" }}>
              {x.porQue}
            </p>
          </div>
        ))}
      </section>

      {/* -------------------------------------------------- el alta --- */}

      {abierto && (
        <>
          <div className="velo" onClick={() => setAbierto(false)} aria-hidden="true" />
          <aside className="cajon" role="dialog" aria-modal="true" aria-label="Dar acceso">
            <div className="cajon-cabecera">
              <h2>Dar acceso al panel</h2>
              <button className="chico" onClick={() => setAbierto(false)}>
                Cerrar
              </button>
            </div>

            <div className="cajon-cuerpo">
              {/* Numerado y con el atajo, no en prosa: dar de alta a alguien se
                  hace cinco o diez veces en la vida del sistema, o sea que nadie
                  se lo va a acordar. El paso 1 vive en Supabase porque crear una
                  cuenta necesita la clave de servicio, y el panel no la tiene a
                  propósito — es lo que hace que un bug acá devuelva cero filas en
                  vez de toda la base. */}
              <div className="aviso info">
                <strong>Esto no crea la cuenta.</strong> Son dos pasos y el primero es en Supabase.
                <ol className="pasos-alta">
                  <li>
                    Creá la cuenta con el correo institucional y una contraseña temporal, marcando
                    <strong> Auto Confirm</strong>.
                    {enlaceASupabase() && (
                      <>
                        {" "}
                        <a href={enlaceASupabase() ?? ""} target="_blank" rel="noreferrer">
                          Abrir Supabase ↗
                        </a>
                      </>
                    )}
                  </li>
                  <li>
                    Volvé acá, tocá <strong>Buscar de nuevo</strong> y aparece en la lista para
                    ponerle nombre y rol.
                  </li>
                </ol>
                Pasale la contraseña por un canal aparte. No hay recuperación por correo: si la
                pierde, se la cambiás vos desde la misma pantalla de Supabase.
              </div>

              {cargando ? (
                <p className="ayuda">Buscando cuentas sin acceso…</p>
              ) : cuentas === null ? null : cuentas.length === 0 ? (
                <div className="tarjeta vacio">
                  <p style={{ margin: 0 }}>
                    Todas las cuentas de Supabase ya tienen acceso. Para sumar a alguien, hacé el
                    paso 1 de arriba y volvé.
                  </p>
                  {/* El botón importa: sin él hay que cerrar el cajón y volver a
                      abrirlo para que se vuelva a consultar, y desde acá no se ve
                      que eso sea lo que hay que hacer. */}
                  <div className="acciones" style={{ justifyContent: "center", marginTop: 14 }}>
                    {enlaceASupabase() && (
                      <a
                        className="boton"
                        href={enlaceASupabase() ?? ""}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Abrir Supabase ↗
                      </a>
                    )}
                    <button className="primario" onClick={() => void abrirAlta()} disabled={cargando}>
                      {cargando ? "Buscando…" : "Buscar de nuevo"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="campo">
                  <label>¿A quién?</label>
                  <p className="ayuda" style={{ marginTop: 0 }}>
                    Son las cuentas de Supabase que todavía no tienen acceso. No hay un campo para
                    escribir el correo a mano a propósito: si no existe la cuenta, el error que da
                    no le dice nada a nadie.
                  </p>
                  <div className="lista-cuentas">
                    {cuentas.map((c) => (
                      <label key={c.usuario_id} className={elegida?.usuario_id === c.usuario_id ? "elegida" : ""}>
                        <input
                          type="radio"
                          name="cuenta"
                          checked={elegida?.usuario_id === c.usuario_id}
                          onChange={() => setElegida(c)}
                        />
                        <span>
                          <strong>{c.correo}</strong>
                          <span className="sub-fila">
                            creada {fechaLegible(c.creada_en)}
                            {!c.confirmada && " · sin confirmar"}
                            {c.ultimo_ingreso === null
                              ? " · nunca entró"
                              : ` · último ingreso ${fechaLegible(c.ultimo_ingreso)}`}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {elegida && (
                <>
                  <div className="campo">
                    <label htmlFor="p-nombre">Nombre y apellido</label>
                    <input
                      id="p-nombre"
                      type="text"
                      value={nombre}
                      onChange={(e) => setNombre(e.target.value)}
                      placeholder="María González"
                    />
                    <p className="ayuda">
                      Obligatorio. Sin nombres, esta pantalla es una lista de correos y quien revise
                      quién tiene acceso dentro de seis meses no va a reconocer a nadie.
                    </p>
                  </div>

                  <div className="campo">
                    <label htmlFor="p-rol">Qué va a poder hacer</label>
                    <select
                      id="p-rol"
                      value={rol}
                      onChange={(e) => setRol(e.target.value as RolPanel)}
                    >
                      {(Object.keys(ROLES_PANEL) as RolPanel[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLES_PANEL[r].rotulo}
                        </option>
                      ))}
                    </select>
                    <p className="ayuda">{ROLES_PANEL[rol].puede}</p>
                    {rol === "admin" && (
                      <div className="detalle-problema" style={{ marginTop: 6 }}>
                        Un administrador puede dar y quitar el acceso de cualquiera, incluido el
                        tuyo. Dalo sólo si corresponde.
                      </div>
                    )}
                  </div>

                  <div className="campo">
                    <label htmlFor="p-notas">Notas (opcional)</label>
                    <input
                      id="p-notas"
                      type="text"
                      value={notas}
                      onChange={(e) => setNotas(e.target.value)}
                      placeholder="Área de Higiene Urbana · alta pedida por Dirección"
                    />
                    <p className="ayuda">
                      Sirve para el día que alguien pregunte por qué esta persona tiene acceso.
                    </p>
                  </div>
                </>
              )}
            </div>

            <div className="cajon-pie">
              <button onClick={() => setAbierto(false)}>Cancelar</button>
              <button
                className="primario"
                disabled={pendiente || elegida === null || nombre.trim() === ""}
                onClick={() =>
                  ejecutar(async () => {
                    const r = await darDeAlta({
                      usuarioId: elegida!.usuario_id,
                      correo: elegida!.correo,
                      nombre,
                      rol,
                      notas,
                    });
                    if (r.ok) setAbierto(false);
                    return r;
                  })
                }
              >
                {pendiente ? "Dando acceso…" : "Dar acceso"}
              </button>
            </div>
          </aside>
        </>
      )}
    </>
  );
}
