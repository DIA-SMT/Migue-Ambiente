"use client";

import { useEffect, useState } from "react";
import {
  fechaLegible,
  ORIGENES_RESPUESTA,
  type Conversacion,
  type MensajeTranscripto,
} from "@/lib/tipos";
import { leerTranscripcion } from "./acciones";

/**
 * La charla completa, como la vio el vecino.
 *
 * Se lee al abrir y no viene con la lista: son doscientas conversaciones y traer
 * todos los mensajes de todas para mostrar una sería traerse la bitácora entera
 * del bot en cada carga de la pantalla.
 *
 * Se muestra como conversación de mensajería y no como tabla de filas, aunque
 * una tabla sería más compacta. El motivo es lo que se viene a hacer acá:
 * entender por qué un vecino votó que no le sirvió. Eso se hace LEYENDO el ida y
 * vuelta en el orden en que pasó, y una tabla con columnas de dirección y hora
 * obliga a reconstruir mentalmente lo que la burbuja muestra solo.
 *
 * La traza —de dónde salió la respuesta, cuánto costó— va debajo de cada mensaje
 * del bot, en chico. Es lo que convierte «Migue contestó mal» en «Migue contestó
 * con un fragmento del PDF del Plan Rector», que es lo accionable.
 */
export function Transcripcion({
  conversacion,
  alCerrar,
}: {
  conversacion: Conversacion;
  alCerrar: () => void;
}) {
  const [mensajes, setMensajes] = useState<MensajeTranscripto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    void leerTranscripcion(conversacion.id).then((r) => {
      // Si mientras cargaba se abrió otra charla, esta respuesta ya no
      // corresponde: escribirla mostraría los mensajes de una conversación
      // dentro de la ficha de otra.
      if (!vigente) return;
      if (r.ok) setMensajes(r.mensajes);
      else setError(r.mensaje);
    });
    return () => {
      vigente = false;
    };
  }, [conversacion.id]);

  const costo = (mensajes ?? []).reduce((n, m) => n + (m.costo_usd ?? 0), 0);

  return (
    <>
      <div className="velo" onClick={alCerrar} aria-hidden="true" />
      <aside className="cajon ancho" role="dialog" aria-modal="true" aria-label="La conversación">
        <div className="cajon-cabecera">
          <h2>{conversacion.nombre_usuario ?? "Vecino sin nombre"}</h2>
          <button className="chico" onClick={alCerrar}>
            Cerrar
          </button>
        </div>

        <div className="cajon-cuerpo">
          <dl className="ficha">
            <div>
              <dt>Canal</dt>
              <dd>{conversacion.canal}</dd>
            </div>
            <div>
              <dt>Empezó</dt>
              <dd>{fechaLegible(conversacion.iniciada_en, true)}</dd>
            </div>
            <div>
              <dt>Estado</dt>
              <dd>{conversacion.estado}</dd>
            </div>
            <div>
              <dt>Mensajes</dt>
              <dd>{conversacion.cantidad_mensajes}</dd>
            </div>
            {costo > 0 && (
              <div>
                <dt>Costó</dt>
                {/* Seis decimales: una charla sale centésimas de centavo y
                    redondear a dos mostraría 0,00 en todas. */}
                <dd>US$ {costo.toFixed(6)}</dd>
              </div>
            )}
            {conversacion.flujo_activo && (
              <div>
                <dt>Quedó a medias en</dt>
                <dd>{conversacion.flujo_activo}</dd>
              </div>
            )}
          </dl>

          {error && <div className="aviso mal">{error}</div>}
          {mensajes === null && !error && <div className="tarjeta vacio">Cargando la charla…</div>}

          {mensajes !== null && (
            <div className="charla">
              {mensajes.map((m) => (
                <div key={m.id} className={`burbuja ${m.direccion}`}>
                  <div className="cuerpo">
                    {m.texto ?? <em className="ayuda">(sin texto)</em>}
                    {m.media_tipo && (
                      <div className="sub-fila" style={{ marginTop: 4 }}>
                        adjuntó {m.media_tipo}
                      </div>
                    )}
                  </div>

                  <div className="pie">
                    <span>{fechaLegible(m.creado_en, true)}</span>
                    {m.origen_respuesta && (
                      <span title="De dónde salió esta respuesta">
                        · {ORIGENES_RESPUESTA[m.origen_respuesta] ?? m.origen_respuesta}
                      </span>
                    )}
                    {m.confianza !== null && <span>· confianza {m.confianza.toFixed(2)}</span>}
                  </div>

                  {m.voto && (
                    // El voto va pegado a la burbuja que valoró, no al final de
                    // la charla. Es lo que responde «cuál de las cuatro
                    // respuestas falló», que es la pregunta que trae a alguien
                    // a leer una conversación.
                    <div className={`voto ${m.voto}`}>
                      <span className="pulgar">{m.voto === "util" ? "👍" : "👎"}</span>
                      <span>
                        {m.voto === "util"
                          ? "El vecino dijo que esto le sirvió"
                          : "El vecino dijo que esto NO le sirvió"}
                      </span>
                      {m.comentario && <blockquote>{m.comentario}</blockquote>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
