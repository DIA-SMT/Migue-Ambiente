"use client";

import { useState } from "react";
import type { Faq } from "@/lib/tipos";
import { guardarFaq, resolverConFaq, type Resultado } from "./acciones";

/**
 * Escribir o editar una pregunta frecuente.
 *
 * La pregunta importa tanto como la respuesta: `faqs.busqueda` le da a la
 * pregunta peso «A» y a la respuesta peso «B», así que lo que se escribe en la
 * pregunta es lo que hace que Migue la encuentre. Conviene escribirla como la
 * escribiría un vecino, no como la enunciaría el área.
 *
 * Con `resolviendo` el cajón hace además de cierre del circuito: viene de una
 * pregunta que Migue no supo contestar, y guarda por la RPC que escribe la
 * respuesta y marca la pregunta en la misma transacción.
 *
 * La pregunta del vecino se precarga TEXTUAL, con sus palabras y sus errores de
 * tipeo. No es descuido: es exactamente el texto que falló al buscar, así que es
 * el que mejor hace que la próxima vez encuentre. Se puede editar, pero el
 * primer borrador tiene que ser el original.
 */
export function CajonFaq({
  faq,
  puedePublicar,
  resolviendo = null,
  alCerrar,
  alTerminar,
}: {
  faq: Faq | null;
  puedePublicar: boolean;
  resolviendo?: { id: string; pregunta: string } | null;
  alCerrar: () => void;
  alTerminar: (r: Resultado) => void;
}) {
  const [pregunta, setPregunta] = useState(faq?.pregunta ?? resolviendo?.pregunta ?? "");
  const [respuesta, setRespuesta] = useState(faq?.respuesta ?? "");
  const [etiquetas, setEtiquetas] = useState(faq?.etiquetas.join(", ") ?? "");
  const [activa, setActiva] = useState(faq?.activa ?? false);
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    setGuardando(true);
    alTerminar(
      resolviendo
        ? await resolverConFaq({
            sinRespuestaId: resolviendo.id,
            pregunta,
            respuesta,
            etiquetas,
            activa,
          })
        : await guardarFaq({ id: faq?.id ?? null, pregunta, respuesta, etiquetas, activa }),
    );
    setGuardando(false);
  }

  return (
    <>
      <div className="velo" onClick={alCerrar} aria-hidden="true" />
      <aside className="cajon" role="dialog" aria-modal="true" aria-label="Pregunta frecuente">
        <div className="cajon-cabecera">
          <h2>
            {resolviendo
              ? "Responder lo que Migue no supo"
              : faq
                ? "Editar pregunta frecuente"
                : "Nueva pregunta frecuente"}
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
                Ya está cargada abajo tal como la escribió. Al guardar, esta pregunta se marca
                resuelta y queda vinculada a la respuesta.
              </p>
            </div>
          )}

          <div className="campo">
            <label htmlFor="pregunta">La pregunta, como la haría un vecino</label>
            <textarea
              id="pregunta"
              value={pregunta}
              onChange={(e) => setPregunta(e.target.value)}
              placeholder="¿Dónde puedo llevar los neumáticos viejos?"
              style={{ minHeight: 60 }}
            />
            <p className="ayuda">
              Es lo que hace que Migue la encuentre: pesa más que la respuesta al buscar. Escribila
              con las palabras que usa la gente, no con las del expediente.
            </p>
          </div>

          <div className="campo">
            <label htmlFor="respuesta">La respuesta</label>
            <textarea
              id="respuesta"
              value={respuesta}
              onChange={(e) => setRespuesta(e.target.value)}
              placeholder="Los neumáticos se reciben en los Puntos Verdes de lunes a viernes de 8 a 13."
              style={{ minHeight: 130 }}
            />
            <p className="ayuda">
              Migue la usa como material para redactar, así que no hace falta que sea la frase
              exacta. Pero si hay un horario o una dirección, escribilos exactos: los transcribe tal
              cual.
            </p>
          </div>

          <div className="campo">
            <label htmlFor="etiquetas">Etiquetas (opcional)</label>
            <input
              id="etiquetas"
              type="text"
              value={etiquetas}
              onChange={(e) => setEtiquetas(e.target.value)}
              placeholder="neumaticos, puntos-verdes"
            />
            <p className="ayuda">
              Separadas por comas. Sirven para filtrar acá en el panel; Migue no las usa para
              buscar.
            </p>
          </div>

          <div className="campo">
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={activa}
                disabled={!puedePublicar}
                onChange={(e) => setActiva(e.target.checked)}
                style={{ width: "auto", marginTop: 3 }}
              />
              <span>
                <strong style={{ display: "block", color: "var(--tinta)" }}>
                  Publicar: Migue la puede usar ya
                </strong>
                <span className="ayuda" style={{ marginTop: 2 }}>
                  {puedePublicar
                    ? "Sin marcar queda como borrador y el bot no la usa."
                    : "Publicar es una acción de supervisor. Guardala como borrador y pedí que la revisen."}
                </span>
              </span>
            </label>
          </div>
        </div>

        <div className="cajon-pie">
          <button onClick={alCerrar}>Cancelar</button>
          <button
            className="primario"
            disabled={guardando || pregunta.trim() === "" || respuesta.trim() === ""}
            onClick={() => void guardar()}
          >
            {guardando ? "Guardando…" : activa ? "Guardar y publicar" : "Guardar borrador"}
          </button>
        </div>
      </aside>
    </>
  );
}
