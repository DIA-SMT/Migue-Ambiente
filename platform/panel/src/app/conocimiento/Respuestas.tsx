"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Faq, PreguntaSinResponder, RespuestaFija, TextoBot } from "@/lib/tipos";
import {
  borrarFaq,
  borrarFija,
  publicarFaq,
  publicarFija,
  type Resultado,
} from "./acciones";
import { CajonFaq } from "./CajonFaq";
import { ListaFaqs } from "./ListaFaqs";
import { CajonFija } from "./CajonFija";
import { ProbarBuscador } from "./ProbarBuscador";
import { SinResponder } from "./SinResponder";
import { EditorTextos } from "./EditorTextos";

/**
 * Todo lo que Migue dice y el área puede cambiar, en cuatro pestañas.
 *
 * «Sin responder» va PRIMERA porque es de donde sale el trabajo: son las
 * preguntas reales que el bot no supo contestar, y responder una es escribir algo
 * de las otras pestañas. Estuvo pensada un rato como sección aparte del panel, y
 * era peor: obligaba a leer la falla en una pantalla y escribir el arreglo en
 * otra, copiando la pregunta a mano.
 *
 * Las otras tres son herramientas distintas y se eligen por criterios distintos.
 * Están separadas, y no en una lista sola, porque juntarlas invitaría a elegir la
 * primera que aparezca:
 *
 *   Frecuente      la busca el buscador y el modelo redacta con ella. Sirve
 *                  cuando la misma pregunta admite muchas formas de hacerse. Es
 *                  la plantilla que el área escribe para un tema puntual.
 *   Textual        se envía TAL CUAL, sin modelo. Para lo que no admite
 *                  interpretación: un teléfono, una dirección, una suspensión.
 *   Cómo habla     las frases fijas del armazón —saludo, menú, despedida, los
 *                  pasos de cada trámite—. Son 21 claves FIJAS: el código las
 *                  busca por nombre, así que se edita el texto y no se agregan
 *                  ni se borran.
 *
 * La cuarta era una sección propia del menú, «Textos del bot». Tenerla aparte
 * obligaba a saber de antemano en cuál de los dos ítems del menú vivía la frase
 * que se quería corregir, y la respuesta no era deducible: «sin_respuesta» —lo
 * que Migue dice cuando no sabe— estaba en Textos, mientras que la pregunta que
 * lo provocó estaba en Respuestas.
 */
export function Respuestas({
  faqs,
  fijas,
  sinResponder,
  puedePublicar,
  mensajesEntrantes,
  gruposDeTexto,
  textosSinAgrupar,
  ejemplos,
}: {
  faqs: Faq[];
  fijas: RespuestaFija[];
  sinResponder: PreguntaSinResponder[];
  puedePublicar: boolean;
  mensajesEntrantes: number;
  gruposDeTexto: {
    rotulo: string;
    explicacion: string;
    textos: TextoBot[];
    faltantes: string[];
  }[];
  textosSinAgrupar: TextoBot[];
  ejemplos: Record<string, string>;
}) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const sinResponderPendientes = sinResponder.filter((p) => p.estado === "pendiente").length;

  // Arranca en «Sin responder» sólo si hay algo que hacer ahí. Abrir siempre en
  // una lista vacía deja la sección aparentando que no hace nada.
  const [pestana, setPestana] = useState<"sin" | "faqs" | "fijas" | "textos">(
    sinResponderPendientes > 0 ? "sin" : "faqs",
  );
  const [aviso, setAviso] = useState<Resultado | null>(null);
  const [editandoFaq, setEditandoFaq] = useState<Faq | null | undefined>(undefined);
  const [editandoFija, setEditandoFija] = useState<RespuestaFija | null | undefined>(undefined);
  const [confirmando, setConfirmando] = useState<string | null>(null);

  // Cuando esto tiene valor, el cajón abierto no está creando una respuesta
  // suelta: está cerrando esta pregunta, y guarda por la RPC que hace las dos
  // escrituras en una sola transacción.
  const [resolviendo, setResolviendo] = useState<{ id: string; pregunta: string } | null>(null);

  function responderCon(cajon: "faq" | "fija", p: PreguntaSinResponder) {
    setResolviendo({ id: p.id, pregunta: p.pregunta });
    if (cajon === "faq") setEditandoFaq(null);
    else setEditandoFija(null);
  }

  function cerrarCajones() {
    setEditandoFaq(undefined);
    setEditandoFija(undefined);
    setResolviendo(null);
  }

  function ejecutar(accion: () => Promise<Resultado>) {
    empezar(async () => {
      setAviso(await accion());
      setConfirmando(null);
      router.refresh();
    });
  }

  const borradoresFaq = faqs.filter((f) => !f.activa).length;
  const borradoresFija = fijas.filter((f) => !f.activa).length;
  const totalTextos =
    gruposDeTexto.reduce((n, g) => n + g.textos.length, 0) + textosSinAgrupar.length;

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

      {pestana !== "textos" && <ProbarBuscador />}

      <div className="pestanas" role="tablist">
        <button
          role="tab"
          aria-selected={pestana === "sin"}
          className={pestana === "sin" ? "activa" : ""}
          onClick={() => setPestana("sin")}
        >
          Sin responder
          <span className="cuenta">{sinResponderPendientes}</span>
        </button>
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
        <button
          role="tab"
          aria-selected={pestana === "textos"}
          className={pestana === "textos" ? "activa" : ""}
          onClick={() => setPestana("textos")}
        >
          Cómo habla Migue
          <span className="cuenta">{totalTextos}</span>
        </button>
      </div>

      {pestana === "sin" ? (
        <SinResponder
          preguntas={sinResponder}
          alResponderConFaq={(p) => responderCon("faq", p)}
          alResponderConFija={(p) => responderCon("fija", p)}
          alCambiar={(r) => {
            setAviso(r);
            router.refresh();
          }}
        />
      ) : pestana === "faqs" ? (
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
            <ListaFaqs
              faqs={faqs}
              pendiente={pendiente}
              confirmando={confirmando}
              alEditar={setEditandoFaq}
              alPublicar={(f) => ejecutar(() => publicarFaq(f.id, !f.activa))}
              alPedirBorrar={setConfirmando}
              alBorrar={(id) => ejecutar(() => borrarFaq(id))}
              alCancelarBorrado={() => setConfirmando(null)}
            />
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

      {pestana === "textos" && (
        <>
          <p className="bajada" style={{ marginTop: 16 }}>
            Las frases con las que Migue arma cada conversación. Se envían{" "}
            <strong>tal cual</strong>, sin que el modelo las reescriba.
          </p>
          <div className="aviso info">
            Estas frases son fijas: se edita el texto, pero no se agregan ni se borran. El código
            las busca por nombre, así que si una desapareciera el bot mandaría un aviso de error en
            su lugar. Para responder algo nuevo, usá una pregunta frecuente.
          </div>
          <EditorTextos
            grupos={gruposDeTexto}
            sinAgrupar={textosSinAgrupar}
            ejemplos={ejemplos}
          />
        </>
      )}

      {editandoFaq !== undefined && (
        <CajonFaq
          faq={editandoFaq}
          puedePublicar={puedePublicar}
          resolviendo={resolviendo}
          alCerrar={cerrarCajones}
          alTerminar={(r: Resultado) => {
            setAviso(r);
            if (r.ok) cerrarCajones();
            router.refresh();
          }}
        />
      )}

      {editandoFija !== undefined && (
        <CajonFija
          fija={editandoFija}
          puedePublicar={puedePublicar}
          mensajesEntrantes={mensajesEntrantes}
          resolviendo={resolviendo}
          alCerrar={cerrarCajones}
          alTerminar={(r: Resultado) => {
            setAviso(r);
            if (r.ok) cerrarCajones();
            router.refresh();
          }}
        />
      )}
    </>
  );
}
