"use client";

import { useState } from "react";
import type { FilaExclusion } from "@/lib/tipos";
import {
  borrarExclusion,
  guardarExclusion,
  probarExclusiones,
  type Resultado,
} from "./acciones";

/**
 * Lo que no es de Ambiente y se deriva.
 *
 * Estas reglas corren ANTES que todo lo demás, incluso en medio de un trámite: si
 * alguien escribe «hay olor a gas» mientras pide un retiro de escombros,
 * corresponde derivarlo ya. Eso las hace potentes y peligrosas — una palabra
 * demasiado genérica interrumpe conversaciones legítimas.
 *
 * Por eso el probador es la parte más importante de la pestaña, y por eso usa la
 * función REAL del bot. Había una RPC en la base que parecía servir
 * (`probar_disparadores`, de la 019) y compara por SUBCADENA: con la palabra
 * «gas» habría dado por atrapados «gasnor», «gaseoso» y «desgaste». El bot
 * compara por palabra completa. Un probador con esa RPC habría llevado a alguien
 * a borrar palabras que funcionan bien.
 */
export function Exclusiones({
  filas,
  alGuardar,
}: {
  filas: FilaExclusion[];
  alGuardar: (r: Resultado) => void;
}) {
  const [editando, setEditando] = useState<FilaExclusion | null | undefined>(undefined);
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [textoPrueba, setTextoPrueba] = useState("");
  const [probando, setProbando] = useState(false);
  const [prueba, setPrueba] = useState<
    | { coincidencias: { nombre: string; palabra: string; prioridad: number; corta: boolean }[] }
    | { error: string }
    | null
  >(null);

  // Formulario
  const [nombre, setNombre] = useState("");
  const [palabras, setPalabras] = useState("");
  const [respuesta, setRespuesta] = useState("");
  const [prioridad, setPrioridad] = useState("50");
  const [activa, setActiva] = useState(true);

  function abrir(f: FilaExclusion | null) {
    setEditando(f);
    setNombre(f?.nombre ?? "");
    setPalabras((f?.palabras ?? []).join("\n"));
    setRespuesta(f?.respuesta ?? "");
    setPrioridad(String(f?.prioridad ?? 50));
    setActiva(f?.activa ?? true);
  }

  async function guardar() {
    setGuardando(true);
    const r = await guardarExclusion({
      id: editando?.id ?? null,
      nombre,
      palabras,
      respuesta,
      prioridad,
      activa,
    });
    alGuardar(r);
    setGuardando(false);
    if (r.ok) setEditando(undefined);
  }

  async function probar() {
    setProbando(true);
    const r = await probarExclusiones(
      textoPrueba,
      filas.map((f) => ({
        id: f.id,
        nombre: f.nombre,
        palabras: f.palabras,
        organismo: f.organismo,
        respuesta: f.respuesta,
        accion: f.accion,
        prioridad: f.prioridad,
        activa: f.activa,
      })),
    );
    setPrueba(r.ok ? { coincidencias: r.coincidencias } : { error: r.mensaje });
    setProbando(false);
  }

  return (
    <>
      <p className="bajada" style={{ marginTop: 16 }}>
        Temas que no son de Ambiente. Si el mensaje de un vecino contiene una de estas palabras,
        Migue le manda la respuesta cargada acá y no sigue con nada más — incluso si estaba en
        medio de un trámite.
      </p>

      {/* El probador va ARRIBA de la lista, no abajo: es lo primero que hay que
          hacer antes de agregar una palabra, no lo último. */}
      <section className="tarjeta" style={{ padding: 16, marginBottom: 18 }}>
        <h3 style={{ marginTop: 0 }}>Probar un mensaje</h3>
        <p className="ayuda" style={{ marginTop: 0 }}>
          Con la misma función que usa el bot: compara <strong>palabras completas</strong>, no
          pedazos. «gas» no atrapa «desgaste», y sí atrapa «gases».
        </p>
        <div className="regla-control">
          <input
            type="text"
            value={textoPrueba}
            onChange={(e) => setTextoPrueba(e.target.value)}
            placeholder="hay olor a gas en la esquina"
            style={{ maxWidth: 420 }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void probar();
            }}
          />
          <button className="primario chico" disabled={probando} onClick={() => void probar()}>
            {probando ? "Probando…" : "Probar"}
          </button>
        </div>

        {prueba !== null &&
          ("error" in prueba ? (
            <div className="aviso mal" style={{ marginTop: 12 }}>
              {prueba.error}
            </div>
          ) : prueba.coincidencias.length === 0 ? (
            <div style={{ marginTop: 12 }}>
              <span className="chip ok">no se deriva</span>
              <p className="ayuda">
                Ninguna regla coincide. Migue lo trata como una consulta o un trámite normal.
              </p>
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <span className="chip alerta">se deriva</span>
              <p className="ayuda" style={{ marginBottom: 8 }}>
                Coincidieron {prueba.coincidencias.length}{" "}
                {prueba.coincidencias.length === 1 ? "regla" : "reglas"}. Gana la de menor
                prioridad; las demás no se usan.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {prueba.coincidencias.map((c, i) => (
                  <li key={c.nombre} style={{ marginBottom: 4 }}>
                    <strong>{c.nombre}</strong> por la palabra «{c.palabra}» (prioridad{" "}
                    {c.prioridad})
                    {i === 0 ? (
                      <span className="chip alerta" style={{ marginLeft: 6 }}>
                        esta es la que actúa
                      </span>
                    ) : (
                      <span className="sub-fila"> — coincide pero no se usa</span>
                    )}
                  </li>
                ))}
              </ul>
              {prueba.coincidencias.length > 2 && (
                <div className="detalle-problema" style={{ marginTop: 8 }}>
                  Tres o más reglas sobre el mismo mensaje suele significar que alguna tiene
                  palabras demasiado genéricas. «agua» aparece en muchísimas consultas ambientales
                  legítimas.
                </div>
              )}
            </div>
          ))}
      </section>

      <div style={{ marginBottom: 14 }}>
        <button className="primario" onClick={() => abrir(null)}>
          Agregar un tema para derivar
        </button>
      </div>

      <div className="envoltorio-tabla tarjeta">
        <table>
          <thead>
            <tr>
              <th>Tema</th>
              <th>Palabras</th>
              <th className="num">Prioridad</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.id} className={f.activa ? undefined : "de-baja"}>
                <td style={{ maxWidth: 240 }}>
                  <button className="enlace-tabla" onClick={() => abrir(f)}>
                    {f.nombre}
                  </button>
                  <div
                    style={{
                      color: "var(--tinta-media)",
                      fontSize: "0.85rem",
                      marginTop: 3,
                      maxWidth: "44ch",
                    }}
                  >
                    {f.respuesta.length > 130 ? `${f.respuesta.slice(0, 130)}…` : f.respuesta}
                  </div>
                </td>
                <td style={{ maxWidth: 260 }}>
                  <div className="sub-fila">{f.palabras.join(" · ")}</div>
                </td>
                <td className="num">{f.prioridad}</td>
                <td>
                  <span className={`chip ${f.activa ? "ok" : "pend"}`}>
                    {f.activa ? "activa" : "inactiva"}
                  </span>
                </td>
                <td>
                  <div className="acciones">
                    <button className="chico" onClick={() => abrir(f)}>
                      Editar
                    </button>
                    {confirmando === f.id ? (
                      <>
                        <button
                          className="chico peligro"
                          onClick={() => {
                            void borrarExclusion(f.id).then(alGuardar);
                            setConfirmando(null);
                          }}
                        >
                          Confirmar
                        </button>
                        <button className="chico" onClick={() => setConfirmando(null)}>
                          No
                        </button>
                      </>
                    ) : (
                      <button className="chico peligro" onClick={() => setConfirmando(f.id)}>
                        Borrar
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editando !== undefined && (
        <>
          <div className="velo" onClick={() => setEditando(undefined)} aria-hidden="true" />
          <aside className="cajon" role="dialog" aria-modal="true" aria-label="Tema a derivar">
            <div className="cajon-cabecera">
              <h2>{editando ? "Editar tema" : "Nuevo tema a derivar"}</h2>
              <button className="chico" onClick={() => setEditando(undefined)}>
                Cerrar
              </button>
            </div>

            <div className="cajon-cuerpo">
              <div className="campo">
                <label htmlFor="ex-nombre">Nombre del tema</label>
                <input
                  id="ex-nombre"
                  type="text"
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  placeholder="Alumbrado público"
                />
                <p className="ayuda">Sólo para reconocerlo acá. El vecino no lo ve.</p>
              </div>

              <div className="campo">
                <label htmlFor="ex-palabras">Palabras que lo disparan</label>
                <textarea
                  id="ex-palabras"
                  value={palabras}
                  onChange={(e) => setPalabras(e.target.value)}
                  placeholder={"alumbrado\nfoco quemado\nposte de luz"}
                  style={{ minHeight: 110, fontFamily: "var(--mono)", fontSize: "0.88rem" }}
                />
                <p className="ayuda">
                  Una por línea. Se comparan como <strong>palabras completas</strong>, sin acentos y
                  sin distinguir mayúsculas, y el plural se reconoce solo: cargar «neumatico»
                  también atrapa «neumaticos». Cuidado con las palabras cortas y genéricas: «agua»
                  aparece en muchas consultas que sí son de Ambiente. Probala arriba antes de
                  guardar.
                </p>
              </div>

              <div className="campo">
                <label htmlFor="ex-respuesta">Lo que Migue le contesta</label>
                <textarea
                  id="ex-respuesta"
                  value={respuesta}
                  onChange={(e) => setRespuesta(e.target.value)}
                  placeholder="Eso lo atiende el ENTE de alumbrado. Podés llamar al 0800-..."
                  style={{ minHeight: 110 }}
                />
                <p className="ayuda">
                  Se envía <strong>tal cual</strong> y la conversación se cierra. Conviene que
                  incluya a dónde tiene que ir el vecino: es lo único que va a recibir.
                </p>
              </div>

              <div className="campo">
                <label htmlFor="ex-prioridad">Prioridad</label>
                <input
                  id="ex-prioridad"
                  type="text"
                  value={prioridad}
                  onChange={(e) => setPrioridad(e.target.value)}
                  style={{ maxWidth: 110 }}
                />
                <p className="ayuda">
                  El número más bajo gana. Importa cuando un mensaje coincide con dos reglas: «se
                  rompió el caño de gas y hay escombros» tiene que ir a gas, que está en 10, y no al
                  flujo de escombros.
                </p>
              </div>

              <div className="campo">
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={activa}
                    onChange={(e) => setActiva(e.target.checked)}
                    style={{ width: "auto" }}
                  />
                  <span>Activa</span>
                </label>
              </div>
            </div>

            <div className="cajon-pie">
              <button onClick={() => setEditando(undefined)}>Cancelar</button>
              <button
                className="primario"
                disabled={guardando || nombre.trim() === "" || respuesta.trim() === ""}
                onClick={() => void guardar()}
              >
                {guardando ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </aside>
        </>
      )}
    </>
  );
}
