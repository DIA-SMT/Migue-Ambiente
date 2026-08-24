"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Faq, RespuestaFija } from "@/lib/tipos";
import {
  borrarFaq,
  borrarFija,
  publicarFaq,
  publicarFija,
  type Resultado,
} from "./acciones";
import { CajonFaq } from "./CajonFaq";
import { CajonFija } from "./CajonFija";
import { ProbarBuscador } from "./ProbarBuscador";

/**
 * Las dos clases de respuesta, en pestañas.
 *
 * Están separadas y no mezcladas en una lista porque son herramientas
 * distintas y se eligen por criterios distintos:
 *
 *   FAQ            la busca el buscador y el modelo redacta con ella. Sirve
 *                  cuando la pregunta admite muchas formas de preguntarse.
 *   Respuesta fija se envía TEXTUAL, sin modelo. Sirve para lo que no admite
 *                  interpretación: un teléfono, una dirección, una suspensión.
 *
 * Ponerlas en la misma lista invitaría a elegir la primera que aparezca.
 */
export function Respuestas({
  faqs,
  fijas,
  puedePublicar,
  mensajesEntrantes,
}: {
  faqs: Faq[];
  fijas: RespuestaFija[];
  puedePublicar: boolean;
  mensajesEntrantes: number;
}) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const [pestana, setPestana] = useState<"faqs" | "fijas">("faqs");
  const [aviso, setAviso] = useState<Resultado | null>(null);
  const [editandoFaq, setEditandoFaq] = useState<Faq | null | undefined>(undefined);
  const [editandoFija, setEditandoFija] = useState<RespuestaFija | null | undefined>(undefined);
  const [confirmando, setConfirmando] = useState<string | null>(null);

  function ejecutar(accion: () => Promise<Resultado>) {
    empezar(async () => {
      setAviso(await accion());
      setConfirmando(null);
      router.refresh();
    });
  }

  const borradoresFaq = faqs.filter((f) => !f.activa).length;
  const borradoresFija = fijas.filter((f) => !f.activa).length;

  return (
    <>
      {aviso && (
        <div className={`aviso ${aviso.ok ? "ok" : "mal"}`} role="status">
          {aviso.mensaje}
        </div>
      )}

      {!puedePublicar && (
        <div className="aviso info">
          Tu rol es operador: podés escribir y editar borradores, y un supervisor los publica.
        </div>
      )}

      <ProbarBuscador />

      <div className="pestanas" role="tablist">
        <button
          role="tab"
          aria-selected={pestana === "faqs"}
          className={pestana === "faqs" ? "activa" : ""}
          onClick={() => setPestana("faqs")}
        >
          Preguntas frecuentes
          <span className="cuenta">{faqs.length}</span>
          {borradoresFaq > 0 && <span className="chip curso">{borradoresFaq} sin publicar</span>}
        </button>
        <button
          role="tab"
          aria-selected={pestana === "fijas"}
          className={pestana === "fijas" ? "activa" : ""}
          onClick={() => setPestana("fijas")}
        >
          Respuestas textuales
          <span className="cuenta">{fijas.length}</span>
          {borradoresFija > 0 && <span className="chip curso">{borradoresFija} sin publicar</span>}
        </button>
      </div>

      {pestana === "faqs" ? (
        <>
          <p className="bajada" style={{ marginTop: 16 }}>
            Migue las busca y redacta la respuesta con ellas. Sirven cuando la misma pregunta se
            puede hacer de muchas formas.
          </p>
          <div style={{ marginBottom: 14 }}>
            <button className="primario" onClick={() => setEditandoFaq(null)}>
              Escribir una pregunta frecuente
            </button>
          </div>

          {faqs.length === 0 ? (
            <div className="tarjeta vacio">
              Todavía no hay ninguna. Es lo de mayor impacto que se puede cargar: pesa el doble que
              un fragmento de PDF cuando Migue busca con qué responder.
            </div>
          ) : (
            <div className="envoltorio-tabla tarjeta">
              <table>
                <thead>
                  <tr>
                    <th>Pregunta y respuesta</th>
                    <th>Estado</th>
                    <th className="num">Usos</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {faqs.map((f) => (
                    <tr key={f.id} className={f.activa ? undefined : "de-baja"}>
                      <td>
                        <div className="titulo-fila">{f.pregunta}</div>
                        <div style={{ color: "var(--tinta-media)", fontSize: "0.87rem", marginTop: 3, maxWidth: "62ch" }}>
                          {f.respuesta.length > 200 ? `${f.respuesta.slice(0, 200)}…` : f.respuesta}
                        </div>
                        {f.etiquetas.length > 0 && (
                          <div className="sub-fila" style={{ marginTop: 4 }}>
                            {f.etiquetas.join(" · ")}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`chip ${f.activa ? "ok" : "curso"}`}>
                          {f.activa ? "en uso" : "borrador"}
                        </span>
                      </td>
                      <td className="num">{f.veces_usada}</td>
                      <td>
                        <div className="acciones">
                          <button className="chico" onClick={() => setEditandoFaq(f)}>
                            Editar
                          </button>
                          <button
                            className="chico"
                            disabled={pendiente}
                            onClick={() => ejecutar(() => publicarFaq(f.id, !f.activa))}
                          >
                            {f.activa ? "Despublicar" : "Publicar"}
                          </button>
                          {confirmando === f.id ? (
                            <>
                              <button
                                className="chico peligro"
                                disabled={pendiente}
                                onClick={() => ejecutar(() => borrarFaq(f.id))}
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
          )}
        </>
      ) : (
        <>
          <p className="bajada" style={{ marginTop: 16 }}>
            Se envían <strong>textuales</strong>, sin que el modelo las reescriba. Son para lo que
            no admite interpretación: un teléfono, una dirección, un servicio suspendido.
          </p>
          <div style={{ marginBottom: 14 }}>
            <button className="primario" onClick={() => setEditandoFija(null)}>
              Escribir una respuesta textual
            </button>
          </div>

          {fijas.length === 0 ? (
            <div className="tarjeta vacio">
              Todavía no hay ninguna.
            </div>
          ) : (
            <div className="envoltorio-tabla tarjeta">
              <table>
                <thead>
                  <tr>
                    <th>Respuesta</th>
                    <th>Cuándo se dispara</th>
                    <th>Estado</th>
                    <th className="num">Usos</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {fijas.map((f) => (
                    <tr key={f.id} className={f.activa ? undefined : "de-baja"}>
                      <td>
                        <div className="titulo-fila">{f.nombre}</div>
                        <div style={{ color: "var(--tinta-media)", fontSize: "0.87rem", marginTop: 3, maxWidth: "56ch" }}>
                          {f.respuesta.length > 180 ? `${f.respuesta.slice(0, 180)}…` : f.respuesta}
                        </div>
                      </td>
                      <td style={{ maxWidth: 220 }}>
                        <span className="chip pend">{f.modo}</span>
                        <div className="sub-fila" style={{ marginTop: 4 }}>
                          {f.disparadores.join(" · ")}
                        </div>
                      </td>
                      <td>
                        <span className={`chip ${f.activa ? "ok" : "curso"}`}>
                          {f.activa ? "en uso" : "borrador"}
                        </span>
                      </td>
                      <td className="num">{f.veces_usada}</td>
                      <td>
                        <div className="acciones">
                          <button className="chico" onClick={() => setEditandoFija(f)}>
                            Editar
                          </button>
                          <button
                            className="chico"
                            disabled={pendiente}
                            onClick={() => ejecutar(() => publicarFija(f.id, !f.activa))}
                          >
                            {f.activa ? "Despublicar" : "Publicar"}
                          </button>
                          {confirmando === f.id ? (
                            <>
                              <button
                                className="chico peligro"
                                disabled={pendiente}
                                onClick={() => ejecutar(() => borrarFija(f.id))}
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
          )}
        </>
      )}

      {editandoFaq !== undefined && (
        <CajonFaq
          faq={editandoFaq}
          puedePublicar={puedePublicar}
          alCerrar={() => setEditandoFaq(undefined)}
          alTerminar={(r: Resultado) => {
            setAviso(r);
            if (r.ok) setEditandoFaq(undefined);
            router.refresh();
          }}
        />
      )}

      {editandoFija !== undefined && (
        <CajonFija
          fija={editandoFija}
          puedePublicar={puedePublicar}
          mensajesEntrantes={mensajesEntrantes}
          alCerrar={() => setEditandoFija(undefined)}
          alTerminar={(r: Resultado) => {
            setAviso(r);
            if (r.ok) setEditandoFija(undefined);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
