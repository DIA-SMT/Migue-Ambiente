"use client";

import { useMemo, useState } from "react";
import {
  comoLeFue,
  fechaLegible,
  recortarTexto,
  type Conversacion,
} from "@/lib/tipos";
import { Transcripcion } from "./Transcripcion";

/**
 * Con quién habló Migue y cómo le fue.
 *
 * Es una tabla y no tarjetas —al revés que «Sin responder»— porque acá lo que se
 * hace es BARRER: mirar veinte filas para encontrar las tres que fallaron. Una
 * tarjeta por conversación obligaría a bajar mucho para lo mismo. El texto
 * literal del vecino, que en «Sin responder» era el protagonista, acá es una
 * pista para reconocer la charla y se puede recortar.
 */
type Filtro = "todas" | "fallaron" | "votadas";

export function Conversaciones({
  conversaciones,
  abrirId,
}: {
  conversaciones: Conversacion[];
  /**
   * Qué charla abrir de entrada. Viene de Clima: desde un pulgar abajo se llega
   * acá para leer el ida y vuelta completo, y hacer buscar la fila a mano
   * anularía la mitad del sentido del enlace.
   *
   * Lo resuelve el SERVIDOR y llega como prop, en vez de leerlo acá con
   * `useSearchParams`. Ese hook obliga a envolver el componente en un
   * `<Suspense>` y a que la página se renderice en el cliente; el parámetro ya
   * lo tiene la página, que es un server component.
   */
  abrirId?: string | undefined;
}) {
  const [filtro, setFiltro] = useState<Filtro>("todas");
  // Estado inicial perezoso: la búsqueda corre una sola vez, no en cada render.
  // Si el id no existe —una charla borrada, un enlace viejo— queda en null y la
  // pantalla se ve normal, sin cajón y sin error.
  const [abierta, setAbierta] = useState<Conversacion | null>(
    () => conversaciones.find((c) => c.id === abrirId) ?? null,
  );

  const conFallas = conversaciones.filter(
    // `preguntas_pendientes` y no el total: con el total, «donde algo falló»
    // era monótono creciente y escribir la respuesta no lo bajaba nunca.
    (c) => c.votos_no_utiles > 0 || c.preguntas_pendientes > 0,
  );
  const votadas = conversaciones.filter((c) => c.votos_utiles > 0 || c.votos_no_utiles > 0);

  const visibles = useMemo(() => {
    if (filtro === "fallaron") {
      // Acá SÍ se reordena por gravedad: es la lista de trabajo, no la bitácora.
      return [...conFallas].sort((a, b) => comoLeFue(a).urgencia - comoLeFue(b).urgencia);
    }
    if (filtro === "votadas") return votadas;
    return conversaciones;
  }, [conversaciones, filtro, conFallas, votadas]);

  const utiles = conversaciones.reduce((n, c) => n + c.votos_utiles, 0);
  const noUtiles = conversaciones.reduce((n, c) => n + c.votos_no_utiles, 0);
  const votos = utiles + noUtiles;

  return (
    <>
      <div className="resumen">
        <div>
          <span className="n">{conversaciones.length}</span>
          <span className="r">conversaciones</span>
        </div>
        <div>
          <span className="n">
            {/*
              Con pocos votos un porcentaje es ruido: «100% útil» con un voto no
              dice nada y suena a que está medido. Debajo de diez se muestra el
              crudo, que es la verdad disponible.
            */}
            {votos === 0 ? "—" : votos < 10 ? `${utiles} de ${votos}` : `${Math.round((utiles / votos) * 100)}%`}
          </span>
          <span className="r">
            {votos === 0
              ? "todavía nadie votó"
              : votos < 10
                ? "votaron que les sirvió (son pocos votos para un porcentaje)"
                : "de los votos dijeron que sirvió"}
          </span>
        </div>
        <div>
          <span className="n" style={{ color: conFallas.length > 0 ? "var(--alerta)" : undefined }}>
            {conFallas.length}
          </span>
          <span className="r">donde algo falló</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, margin: "16px 0 12px", flexWrap: "wrap" }}>
        {(
          [
            ["todas", `Todas (${conversaciones.length})`],
            ["fallaron", `Donde falló algo (${conFallas.length})`],
            ["votadas", `Con voto (${votadas.length})`],
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
          {conversaciones.length === 0 ? (
            <>
              Todavía nadie habló con Migue por acá.
              <div style={{ marginTop: 8, fontSize: "0.9rem" }}>
                Cada vez que un vecino le escriba, la charla aparece en esta lista.
              </div>
            </>
          ) : filtro === "fallaron" ? (
            "No hay ninguna donde Migue haya fallado. Buena señal."
          ) : (
            "Todavía nadie votó. El pulgar aparece después de cada respuesta."
          )}
        </div>
      ) : (
        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th>Cómo le fue</th>
                <th>Vecino</th>
                <th>Qué preguntó</th>
                <th className="num">Mensajes</th>
                <th>Última actividad</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => {
                const r = comoLeFue(c);
                return (
                  <tr key={c.id}>
                    <td>
                      <span className={`chip ${r.tono}`}>{r.etiqueta}</span>
                      {c.ultimo_comentario && (
                        // Lo que el vecino dijo que le faltaba. Se muestra en la
                        // LISTA y no sólo al abrir la charla: es la información
                        // más accionable de toda la pantalla, y esconderla
                        // detrás de un clic haría que casi nadie la lea.
                        <div className="detalle-problema">«{c.ultimo_comentario}»</div>
                      )}
                    </td>
                    <td>
                      {c.nombre_usuario ?? "—"}
                      <div className="sub-fila">{c.canal}</div>
                    </td>
                    <td style={{ maxWidth: 300 }}>
                      <button className="enlace-tabla" onClick={() => setAbierta(c)}>
                        {c.primer_mensaje ? recortarTexto(c.primer_mensaje, 90) : "(sin texto)"}
                      </button>
                      {c.flujo_activo && (
                        <div className="sub-fila">quedó a medias en {c.flujo_activo}</div>
                      )}
                    </td>
                    <td className="num">{c.cantidad_mensajes}</td>
                    <td>{fechaLegible(c.ultima_actividad_en, true)}</td>
                    <td>
                      <button className="chico" onClick={() => setAbierta(c)}>
                        Ver la charla
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {abierta && (
        <Transcripcion conversacion={abierta} alCerrar={() => setAbierta(null)} />
      )}
    </>
  );
}
