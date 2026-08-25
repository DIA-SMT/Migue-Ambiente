"use client";

import { useMemo, useState, useTransition } from "react";
import {
  estadoDeLaPregunta,
  fechaLegible,
  MOTIVOS_SIN_RESPUESTA,
  type PreguntaSinResponder,
} from "@/lib/tipos";
import { descartarPregunta, type Resultado } from "./acciones";

/**
 * Lo que Migue no supo contestar.
 *
 * Va PRIMERA de las tres pestañas de Respuestas y no en una sección aparte,
 * porque no es un informe: es la entrada del mismo trabajo. Una pregunta sin
 * responder es el insumo para escribir una respuesta, y separarlas obligaba a
 * leer la lista en una pantalla y escribir en otra, copiando la pregunta a mano.
 *
 * El orden es por veces repetidas y no por fecha. Una pregunta que hicieron
 * catorce vecinos vale catorce veces más que la última que entró, y ordenar por
 * fecha —lo natural en una bandeja— esconde justo eso: lo más repetido suele ser
 * viejo.
 */
type Filtro = "pendientes" | "resueltas" | "todas";

export function SinResponder({
  preguntas,
  alResponderConFaq,
  alResponderConFija,
  alCambiar,
}: {
  preguntas: PreguntaSinResponder[];
  alResponderConFaq: (p: PreguntaSinResponder) => void;
  alResponderConFija: (p: PreguntaSinResponder) => void;
  alCambiar: (r: Resultado) => void;
}) {
  const [pendiente, empezar] = useTransition();
  const [filtro, setFiltro] = useState<Filtro>("pendientes");
  const [descartando, setDescartando] = useState<string | null>(null);
  const [motivoDescarte, setMotivoDescarte] = useState("");

  const ordenadas = useMemo(
    () =>
      [...preguntas].sort((a, b) => {
        if (a.veces_repetida !== b.veces_repetida) return b.veces_repetida - a.veces_repetida;
        return new Date(b.actualizado_en).getTime() - new Date(a.actualizado_en).getTime();
      }),
    [preguntas],
  );

  const visibles = useMemo(() => {
    if (filtro === "todas") return ordenadas;
    if (filtro === "resueltas") return ordenadas.filter((p) => p.estado !== "pendiente");
    return ordenadas.filter((p) => p.estado === "pendiente");
  }, [ordenadas, filtro]);

  const pendientes = preguntas.filter((p) => p.estado === "pendiente");

  // Vecinos golpeados, no filas. Una pregunta repetida doce veces son doce
  // personas que se fueron sin respuesta, y es el número que dice cuánto
  // importa vaciar esta lista.
  const vecesTotales = pendientes.reduce((n, p) => n + p.veces_repetida, 0);

  // Un borrador escrito y sin publicar es trabajo hecho que todavía no sirve:
  // el vecino que repita la pregunta va a fallar igual. Se cuenta aparte porque
  // el arreglo es de una sola acción.
  const faltaPublicar = preguntas.filter(
    (p) => p.estado === "resuelta" && p.respuesta_tipo !== null && p.respuesta_publicada === false,
  ).length;

  function descartar(id: string) {
    empezar(async () => {
      alCambiar(await descartarPregunta(id, motivoDescarte));
      setDescartando(null);
      setMotivoDescarte("");
    });
  }

  return (
    <>
      <p className="bajada" style={{ marginTop: 16 }}>
        Cada línea es algo que un vecino preguntó y Migue no pudo contestar. Es la lista de trabajo
        de esta sección: se responde desde acá y la respuesta queda vinculada a la pregunta que la
        originó.
      </p>

      {faltaPublicar > 0 && (
        <div className="aviso info">
          Hay {faltaPublicar} {faltaPublicar === 1 ? "respuesta escrita" : "respuestas escritas"} que
          {faltaPublicar === 1 ? " sigue" : " siguen"} sin publicar. Hasta que un supervisor
          {faltaPublicar === 1 ? " la publique" : " las publique"}, Migue vuelve a fallar con esas
          preguntas.
        </div>
      )}

      <div className="resumen">
        <div>
          <span className="n" style={{ color: pendientes.length > 0 ? "var(--alerta)" : undefined }}>
            {pendientes.length}
          </span>
          <span className="r">sin responder</span>
        </div>
        <div>
          <span className="n">{vecesTotales}</span>
          <span className="r">veces que alguien se quedó sin respuesta</span>
        </div>
        <div>
          <span className="n">{preguntas.filter((p) => p.estado === "resuelta").length}</span>
          <span className="r">ya resueltas</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, margin: "16px 0 12px", flexWrap: "wrap" }}>
        {(
          [
            ["pendientes", `Sin responder (${pendientes.length})`],
            ["resueltas", `Cerradas (${preguntas.length - pendientes.length})`],
            ["todas", `Todas (${preguntas.length})`],
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
          {filtro === "pendientes" && preguntas.length === 0 ? (
            <>
              Todavía no hay ninguna. Esta lista se llena sola: cada vez que Migue no encuentra con
              qué contestar, la pregunta cae acá.
              <div style={{ marginTop: 8, fontSize: "0.9rem" }}>
                Si querés verla funcionar, preguntale por Telegram algo que seguro no sepa.
              </div>
            </>
          ) : filtro === "pendientes" ? (
            "No queda ninguna sin responder."
          ) : (
            "Nada todavía."
          )}
        </div>
      ) : (
        <div className="lista-preguntas">
          {visibles.map((p) => {
            const motivo = MOTIVOS_SIN_RESPUESTA[p.motivo];
            const estado = estadoDeLaPregunta(p);
            const abierta = p.estado === "pendiente";

            return (
              <article key={p.id} className={`tarjeta pregunta ${abierta ? "" : "de-baja"}`}>
                <header>
                  <div className="marcas">
                    {p.veces_repetida > 1 && (
                      <span className="veces" title="Cuántos vecinos preguntaron lo mismo">
                        ×{p.veces_repetida}
                      </span>
                    )}
                    <span className={`chip ${motivo.tono}`}>{motivo.etiqueta}</span>
                    <span className={`chip ${estado.tono}`}>{estado.etiqueta}</span>
                    {p.confianza !== null && (
                      <span className="sub-fila" title="Qué tan flojo fue lo que encontró">
                        confianza {p.confianza.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <span className="sub-fila">
                    {p.veces_repetida > 1
                      ? `la última, ${fechaLegible(p.actualizado_en, true)}`
                      : fechaLegible(p.creado_en, true)}
                  </span>
                </header>

                <blockquote>{p.pregunta}</blockquote>

                {abierta ? (
                  <p className="ayuda">{motivo.queHacer}</p>
                ) : (
                  estado.detalle && <p className="ayuda">{estado.detalle}</p>
                )}

                {abierta &&
                  (descartando === p.id ? (
                    <div className="descarte">
                      <label htmlFor={`motivo-${p.id}`}>¿Por qué se descarta?</label>
                      <input
                        id={`motivo-${p.id}`}
                        type="text"
                        value={motivoDescarte}
                        onChange={(e) => setMotivoDescarte(e.target.value)}
                        placeholder="Es una prueba nuestra / no es de Ambiente / no se entiende"
                      />
                      <p className="ayuda">
                        Queda anotado y la pregunta no se borra, así que se puede revisar si se
                        descartó de más.
                      </p>
                      <div className="acciones">
                        <button
                          className="chico peligro"
                          disabled={pendiente}
                          onClick={() => descartar(p.id)}
                        >
                          Descartar
                        </button>
                        <button
                          className="chico"
                          onClick={() => {
                            setDescartando(null);
                            setMotivoDescarte("");
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="acciones">
                      {p.motivo === "fuera_de_alcance" ? (
                        // Una derivación tiene DOS respuestas correctas y son
                        // opuestas, así que la etiqueta del botón principal
                        // cambia. «Responder con una frecuente» acá empujaría a
                        // escribir una FAQ sobre licencias de conducir.
                        <>
                          <button className="primario chico" onClick={() => alResponderConFaq(p)}>
                            Era nuestro: escribir la respuesta
                          </button>
                          <button className="chico" onClick={() => alResponderConFija(p)}>
                            Respuesta textual
                          </button>
                        </>
                      ) : motivo.accionable ? (
                        <>
                          <button className="primario chico" onClick={() => alResponderConFaq(p)}>
                            Responder con una frecuente
                          </button>
                          <button className="chico" onClick={() => alResponderConFija(p)}>
                            Respuesta textual
                          </button>
                        </>
                      ) : (
                        <span className="ayuda" style={{ margin: 0 }}>
                          No se arregla escribiendo una respuesta.
                        </span>
                      )}
                      <button
                        className="chico"
                        onClick={() => {
                          setDescartando(p.id);
                          // Para una derivación, descartar significa «estuvo bien
                          // derivado», que es la respuesta correcta en la mayoría
                          // de los casos. Se precarga el motivo: escribirlo a
                          // mano cada vez desalienta revisar la lista, y una
                          // lista que nadie revisa no sirve de nada.
                          setMotivoDescarte(
                            p.motivo === "fuera_de_alcance" ? "Estuvo bien derivado a Migue" : "",
                          );
                        }}
                      >
                        {p.motivo === "fuera_de_alcance" ? "Estuvo bien derivado" : "Descartar"}
                      </button>
                    </div>
                  ))}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
