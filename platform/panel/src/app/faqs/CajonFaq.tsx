"use client";

import { useState } from "react";
import type { Faq } from "@/lib/tipos";
import { guardarFaq, type Resultado } from "./acciones";

/**
 * Escribir o editar una pregunta frecuente.
 *
 * La pregunta importa tanto como la respuesta: `faqs.busqueda` le da a la
 * pregunta peso «A» y a la respuesta peso «B», así que lo que se escribe en la
 * pregunta es lo que hace que Migue la encuentre. Conviene escribirla como la
 * escribiría un vecino, no como la enunciaría el área.
 */
export function CajonFaq({
  faq,
  puedePublicar,
  alCerrar,
  alTerminar,
}: {
  faq: Faq | null;
  puedePublicar: boolean;
  alCerrar: () => void;
  alTerminar: (r: Resultado) => void;
}) {
  const [pregunta, setPregunta] = useState(faq?.pregunta ?? "");
  const [respuesta, setRespuesta] = useState(faq?.respuesta ?? "");
  const [etiquetas, setEtiquetas] = useState(faq?.etiquetas.join(", ") ?? "");
  const [activa, setActiva] = useState(faq?.activa ?? false);
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    setGuardando(true);
    alTerminar(
      await guardarFaq({ id: faq?.id ?? null, pregunta, respuesta, etiquetas, activa }),
    );
    setGuardando(false);
  }

  return (
    <>
      <div className="velo" onClick={alCerrar} aria-hidden="true" />
      <aside className="cajon" role="dialog" aria-modal="true" aria-label="Pregunta frecuente">
        <div className="cajon-cabecera">
          <h2>{faq ? "Editar pregunta frecuente" : "Nueva pregunta frecuente"}</h2>
          <button className="chico" onClick={alCerrar}>
            Cerrar
          </button>
        </div>

        <div className="cajon-cuerpo">
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
