"use client";

import { useState } from "react";
import { riesgoDelDisparador, type ModoDisparador, type PruebaDisparadores, type RespuestaFija } from "@/lib/tipos";
import { guardarFija, probarDisparadores, resolverConFija, type Resultado } from "./acciones";

/**
 * Escribir o editar una respuesta textual.
 *
 * Acá el riesgo real no es la respuesta: es el DISPARADOR. Una respuesta fija se
 * envía tal cual, sin que el modelo la interprete, así que si el disparador
 * coincide de más el vecino recibe algo que no tiene nada que ver con lo que
 * preguntó. Y con modo `regex`, un `.*` deja al bot contestando lo mismo a
 * cualquier cosa.
 *
 * Por eso hay que probar antes de publicar, y por eso el botón de publicar
 * queda deshabilitado hasta que se probó al menos una vez.
 *
 * Con `resolviendo` viene de una pregunta que Migue no supo contestar. Se
 * precarga el texto de prueba con la pregunta del vecino —el disparador tiene
 * que atrapar ESA— pero NO los disparadores: la pregunta entera como disparador
 * de tipo «contiene» no volvería a coincidir con nada, y hay que elegir a mano
 * las pocas palabras que la identifican.
 */
export function CajonFija({
  fija,
  puedePublicar,
  mensajesEntrantes,
  resolviendo = null,
  alCerrar,
  alTerminar,
}: {
  fija: RespuestaFija | null;
  puedePublicar: boolean;
  mensajesEntrantes: number;
  resolviendo?: { id: string; pregunta: string } | null;
  alCerrar: () => void;
  alTerminar: (r: Resultado) => void;
}) {
  const [nombre, setNombre] = useState(fija?.nombre ?? "");
  const [disparadores, setDisparadores] = useState(fija?.disparadores.join(", ") ?? "");
  const [modo, setModo] = useState<ModoDisparador>(fija?.modo ?? "contiene");
  const [respuesta, setRespuesta] = useState(fija?.respuesta ?? "");
  const [notas, setNotas] = useState(fija?.notas ?? "");
  const [activa, setActiva] = useState(fija?.activa ?? false);

  const [textoPrueba, setTextoPrueba] = useState(resolviendo?.pregunta ?? "");
  const [prueba, setPrueba] = useState<PruebaDisparadores | null>(null);
  const [errorPrueba, setErrorPrueba] = useState<string | null>(null);
  const [probando, setProbando] = useState(false);
  const [guardando, setGuardando] = useState(false);

  async function probar() {
    setProbando(true);
    setErrorPrueba(null);
    const r = await probarDisparadores(disparadores, modo, textoPrueba);
    if (r.ok) setPrueba(r.prueba);
    else {
      setPrueba(null);
      setErrorPrueba(r.mensaje);
    }
    setProbando(false);
  }

  async function guardar() {
    setGuardando(true);
    alTerminar(
      resolviendo
        ? await resolverConFija({
            sinRespuestaId: resolviendo.id,
            nombre,
            disparadores,
            modo,
            respuesta,
            activa,
            notas,
          })
        : await guardarFija({ id: fija?.id ?? null, nombre, disparadores, modo, respuesta, activa, notas }),
    );
    setGuardando(false);
  }

  const riesgo = prueba ? riesgoDelDisparador(prueba) : null;
  const completo = nombre.trim() !== "" && respuesta.trim() !== "" && disparadores.trim() !== "";

  // No se puede publicar sin haber probado. Es la única validación de este panel
  // que bloquea de verdad, y se justifica: una respuesta fija mal disparada le
  // contesta cualquier cosa a un vecino y nadie se entera hasta que se queja.
  const listoParaPublicar = completo && prueba !== null && riesgo?.tono !== "alerta";

  return (
    <>
      <div className="velo" onClick={alCerrar} aria-hidden="true" />
      <aside className="cajon" role="dialog" aria-modal="true" aria-label="Respuesta textual">
        <div className="cajon-cabecera">
          <h2>
            {resolviendo
              ? "Responder con una respuesta textual"
              : fija
                ? "Editar respuesta textual"
                : "Nueva respuesta textual"}
          </h2>
          <button className="chico" onClick={alCerrar}>
            Cerrar
          </button>
        </div>

        <div className="cajon-cuerpo">
          {resolviendo && (
            <div className="cita-original">
              <span className="rotulo">Lo que preguntó el vecino</span>
              <blockquote>{resolviendo.pregunta}</blockquote>
              <p className="ayuda" style={{ marginTop: 6 }}>
                Ya está cargada como texto de prueba más abajo. Los disparadores van vacíos a
                propósito: hay que elegir las pocas palabras que identifican el tema, porque la
                pregunta entera no volvería a coincidir con nadie.
              </p>
            </div>
          )}
          <div className="campo">
            <label htmlFor="nombre">Nombre</label>
            <input
              id="nombre"
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Neumáticos suspendidos"
            />
            <p className="ayuda">Para identificarla acá. El vecino no lo ve.</p>
          </div>

          <div className="campo">
            <label htmlFor="respuesta">Lo que recibe el vecino, textual</label>
            <textarea
              id="respuesta"
              value={respuesta}
              onChange={(e) => setRespuesta(e.target.value)}
              placeholder="El retiro de neumáticos a domicilio está suspendido. Podés llevarlos a cualquier Punto Verde."
              style={{ minHeight: 120 }}
            />
            <p className="ayuda">
              Se envía <strong>tal cual</strong>, sin que el modelo la reescriba. Revisá la
              redacción como si la estuvieras mandando vos.
            </p>
          </div>

          <hr style={{ border: 0, borderTop: "1px solid var(--linea)", margin: "22px 0" }} />

          <h3 style={{ marginBottom: 4 }}>Cuándo se dispara</h3>
          <p className="ayuda" style={{ marginTop: 0, marginBottom: 14 }}>
            Es la parte delicada: si coincide de más, el vecino recibe esto en vez de la respuesta
            que buscaba.
          </p>

          <div className="campo">
            <label htmlFor="modo">Cómo comparar</label>
            <select id="modo" value={modo} onChange={(e) => { setModo(e.target.value as ModoDisparador); setPrueba(null); }}>
              <option value="contiene">Si el mensaje contiene la palabra</option>
              <option value="exacto">Si el mensaje es exactamente eso</option>
              <option value="regex">Expresión regular (avanzado)</option>
            </select>
            {modo === "regex" && (
              <div className="aviso atencion" style={{ marginTop: 10, marginBottom: 0 }}>
                Con expresión regular es fácil atrapar todo sin querer. Un <code>.*</code> deja a
                Migue contestando esto a cualquier cosa que le escriban.
              </div>
            )}
          </div>

          <div className="campo">
            <label htmlFor="disp">Palabras o expresiones</label>
            <input
              id="disp"
              type="text"
              value={disparadores}
              onChange={(e) => { setDisparadores(e.target.value); setPrueba(null); }}
              placeholder="neumatico, cubierta, goma de auto"
            />
            <p className="ayuda">
              Separadas por comas. No importan las mayúsculas ni los acentos.
            </p>
          </div>

          <div className="campo">
            <label htmlFor="prueba">Probar con un mensaje (opcional)</label>
            <input
              id="prueba"
              type="text"
              value={textoPrueba}
              onChange={(e) => setTextoPrueba(e.target.value)}
              placeholder="donde tiro unas cubiertas viejas"
            />
          </div>

          <button disabled={probando || disparadores.trim() === ""} onClick={() => void probar()}>
            {probando ? "Probando…" : "Probar los disparadores"}
          </button>

          {errorPrueba && (
            <div className="aviso mal" style={{ marginTop: 14 }} role="alert">
              {errorPrueba}
            </div>
          )}

          {prueba && riesgo && (
            <div style={{ marginTop: 14 }}>
              {textoPrueba.trim() !== "" && (
                <div className={`aviso ${prueba.coincide_el_texto ? "ok" : "info"}`}>
                  {prueba.coincide_el_texto
                    ? "Coincide con el mensaje de prueba."
                    : "No coincide con el mensaje de prueba."}
                </div>
              )}

              <div className={`aviso ${riesgo.tono === "ok" ? "ok" : riesgo.tono === "alerta" ? "mal" : "atencion"}`}>
                {riesgo.mensaje}
                {mensajesEntrantes < 20 && prueba.mensajes_mirados > 0 && (
                  <div style={{ marginTop: 6, fontSize: "0.85rem" }}>
                    Ojo: hay sólo {mensajesEntrantes} mensajes de vecinos en total, así que esta
                    medición todavía no dice mucho.
                  </div>
                )}
              </div>

              {prueba.ejemplos.length > 0 && (
                <div className="tarjeta" style={{ padding: "12px 14px" }}>
                  <div className="ayuda" style={{ marginTop: 0, marginBottom: 6 }}>
                    Mensajes reales que atraparía:
                  </div>
                  {prueba.ejemplos.map((e, i) => (
                    <div
                      key={i}
                      style={{ fontSize: "0.86rem", color: "var(--tinta-media)", padding: "3px 0" }}
                    >
                      · {e}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <hr style={{ border: 0, borderTop: "1px solid var(--linea)", margin: "22px 0" }} />

          <div className="campo">
            <label htmlFor="notas">Notas internas (opcional)</label>
            <textarea
              id="notas"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="Por qué se cargó, hasta cuándo aplica, quién lo pidió."
              style={{ minHeight: 60 }}
            />
          </div>

          <div className="campo">
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={activa}
                disabled={!puedePublicar || !listoParaPublicar}
                onChange={(e) => setActiva(e.target.checked)}
                style={{ width: "auto", marginTop: 3 }}
              />
              <span>
                <strong style={{ display: "block", color: "var(--tinta)" }}>
                  Publicar: se le empieza a enviar a los vecinos
                </strong>
                <span className="ayuda" style={{ marginTop: 2 }}>
                  {!puedePublicar
                    ? "Publicar es una acción de supervisor."
                    : prueba === null
                      ? "Primero probá los disparadores. Es lo único que este panel exige antes de publicar."
                      : riesgo?.tono === "alerta"
                        ? "Los disparadores atrapan demasiados mensajes. Hacelos más específicos antes de publicar."
                        : "Sin marcar queda como borrador."}
                </span>
              </span>
            </label>
          </div>
        </div>

        <div className="cajon-pie">
          <button onClick={alCerrar}>Cancelar</button>
          <button className="primario" disabled={guardando || !completo} onClick={() => void guardar()}>
            {guardando ? "Guardando…" : activa ? "Guardar y publicar" : "Guardar borrador"}
          </button>
        </div>
      </aside>
    </>
  );
}
