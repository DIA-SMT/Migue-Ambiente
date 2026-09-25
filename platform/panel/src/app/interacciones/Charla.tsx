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
 * Antes esto era un CAJÓN que se abría encima de la lista. Ahora se despliega
 * dentro de la fila, y la diferencia no es estética: el cajón tapaba la lista,
 * así que comparar dos consultas parecidas —que es lo que uno hace cuando busca
 * qué conocimiento falta— obligaba a abrir, leer, cerrar, buscar la otra, abrir.
 * Desplegado en la fila, el contexto de arriba y de abajo sigue ahí.
 *
 * Se lee al abrir y no viene con la lista: traer todos los mensajes de todas las
 * conversaciones para mostrar una sería bajarse la bitácora entera del bot en
 * cada carga de la pantalla.
 *
 * Se muestra como conversación de mensajería y no como tabla de filas, aunque
 * una tabla sería más compacta. El motivo es lo que se viene a hacer acá:
 * entender por qué un vecino votó que no le sirvió. Eso se hace LEYENDO el ida y
 * vuelta en el orden en que pasó, y una tabla con columnas de dirección y hora
 * obliga a reconstruir mentalmente lo que la burbuja muestra sola.
 *
 * La traza —de dónde salió la respuesta, cuánto costó— va debajo de cada mensaje
 * del bot, en chico. Es lo que convierte «Migue contestó mal» en «Migue contestó
 * con un fragmento del PDF del Plan Rector», que es lo accionable.
 *
 * CUIDADO CON EL FONDO. El contenedor de esto tiene que quedar en `--papel`, el
 * mismo de la tabla. La burbuja del vecino es `--papel-2`, y si el desplegado
 * usara `--papel-2` para distinguirse, la burbuja volvería a ser del color exacto
 * de lo que tiene atrás: es el bug que reportó el área en el cajón. Por eso el
 * desplegado se distingue con un filo de color a la izquierda y no con relleno, y
 * por eso la fila desplegada no toma el `:hover` de la tabla, que también es
 * `--papel-2`.
 */
export function Charla({
  conversacion,
  resaltar,
}: {
  conversacion: Conversacion;
  /**
   * Qué mensaje marcar dentro de la charla. Se abre desde una CONSULTA puntual,
   * y en una charla de veinte mensajes encontrar cuál era exige releerla entera.
   */
  resaltar?: string | undefined;
}) {
  const [mensajes, setMensajes] = useState<MensajeTranscripto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    setMensajes(null);
    setError(null);
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
    <div className="charla-desplegada">
      {/* La ficha de la charla: lo que no entra en la fila de la lista.
          El «cómo le fue» y el comentario del vecino NO van acá aunque sean de
          la charla: ya están en la fila de arriba, a cuarenta píxeles, y
          repetirlos hacía leer dos veces lo mismo. */}
      <div className="charla-cabecera">
        <span className="sub-fila">
          {conversacion.nombre_usuario ?? "Vecino sin nombre"} · {conversacion.canal} ·{" "}
          {conversacion.cantidad_mensajes}{" "}
          {conversacion.cantidad_mensajes === 1 ? "mensaje" : "mensajes"} · empezó{" "}
          {fechaLegible(conversacion.iniciada_en, true)} · {conversacion.estado}
          {/* Seis decimales: una charla sale centésimas de centavo y redondear a
              dos mostraría 0,00 en todas. */}
          {costo > 0 && ` · costó US$ ${costo.toFixed(6)}`}
        </span>
      </div>

      {error && <div className="aviso mal">{error}</div>}
      {mensajes === null && !error && <div className="tarjeta vacio">Cargando la charla…</div>}

      {mensajes !== null && (
        <div className="charla">
          {mensajes.map((m) => (
            <div
              key={m.id}
              className={`burbuja ${m.direccion}${m.id === resaltar ? " resaltada" : ""}`}
            >
              <div className="cuerpo">
                {/* Un entrante sin texto es un botón tocado: el bot manda
                    `texto: null` y no guarda cuál opción fue. «(sin texto)»
                    dejaba al que lee la charla sin entender qué pasó ahí; «tocó
                    una opción» es lo mismo que dice la lista para el mismo caso.
                    Un saliente sin texto sí es raro y se sigue diciendo. */}
                {m.texto ??
                  (m.direccion === "entrante" ? (
                    <em className="ayuda">tocó una opción</em>
                  ) : (
                    <em className="ayuda">(sin texto)</em>
                  ))}
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
                // El voto va pegado a la burbuja que valoró, no al final de la
                // charla. Es lo que responde «cuál de las cuatro respuestas
                // falló», que es la pregunta que trae a alguien a leer una
                // conversación.
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
  );
}
