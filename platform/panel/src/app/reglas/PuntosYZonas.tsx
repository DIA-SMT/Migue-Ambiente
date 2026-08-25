"use client";

import Link from "next/link";
import type { FilaLimite, FilaPuntoVerde, FilaZona } from "@/lib/tipos";

/**
 * Puntos Verdes y zonas de recolección — de sólo lectura, y con la verdad.
 *
 * Esta pestaña no permite editar, y la decisión es deliberada. Las dos tablas
 * están casi desconectadas del bot, y un formulario que guarda un dato que no
 * cambia nada es peor que no tener formulario: alguien corrige una dirección, ve
 * que Migue sigue diciendo la vieja, y deja de creerle al panel entero.
 *
 * Lo verificado, con el código y con datos de producción:
 *
 *   Puntos Verdes  se le muestran al vecino en UN solo lugar del bot, y sólo
 *                  cuando un límite de volumen está en «derivar sin tomar el
 *                  pedido». Hoy los tres límites están en «retiro parcial», así
 *                  que ninguna ruta del bot llega a esta tabla.
 *
 *   Zonas          `catalogo.zonas` se carga y NADIE lo lee. Los días que el
 *                  vecino realmente recibe están escritos a mano dentro del
 *                  texto de confirmación de retiro, que se edita en
 *                  «Conocimiento › Cómo habla Migue».
 *
 * Y las dos cosas SÍ aparecen en las respuestas del bot, pero por otro camino:
 * están escritas adentro de los documentos indexados, así que una consulta libre
 * las contesta desde el PDF. Es lo que avisa el cartel de arriba de la pantalla.
 *
 * Cuando se conecten —o cuando se decida que el bot lea la tabla en vez del
 * documento— esta pestaña pasa a ser editable. Mientras tanto dice qué es cada
 * cosa y a dónde ir para cambiar lo que el vecino lee de verdad.
 */
export function PuntosYZonas({
  puntos,
  zonas,
  limites,
}: {
  puntos: FilaPuntoVerde[];
  zonas: FilaZona[];
  limites: FilaLimite[];
}) {
  // ¿Algún límite está en «derivar sin ticket»? Es la única condición bajo la
  // cual el bot le muestra los Puntos Verdes a un vecino.
  const derivan = limites.filter((l) => l.activo && l.accion_al_exceder === "derivar_sin_ticket");

  return (
    <>
      <p className="bajada" style={{ marginTop: 16 }}>
        Los datos del servicio. Son de sólo lectura por ahora, y abajo está el motivo de cada uno.
      </p>

      {/* ------------------------------------------------ Puntos Verdes --- */}

      <section style={{ marginTop: 22 }}>
        <h2>Puntos Verdes</h2>

        {derivan.length === 0 ? (
          <div className="aviso atencion">
            <strong>Hoy Migue no le muestra esta lista a ningún vecino.</strong>
            <div style={{ marginTop: 6 }}>
              Se la muestra en un solo caso: cuando un pedido se pasa del límite y ese límite está
              configurado como «derivar sin tomar el pedido». Los{" "}
              {limites.filter((l) => l.activo).length} límites activos están en «retiro parcial»,
              así que esa rama no se alcanza. Se cambia en la pestaña{" "}
              <strong>Cuánto se puede sacar</strong>.
            </div>
          </div>
        ) : (
          <div className="aviso info">
            Migue muestra esta lista cuando un pedido de{" "}
            {derivan.map((l) => l.etiqueta).join(" o ")} se pasa del límite, porque esa categoría
            está configurada como «derivar sin tomar el pedido».
          </div>
        )}

        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th className="num">Orden</th>
                <th>Dirección</th>
                <th>Horario</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {puntos.map((p) => (
                <tr key={p.id} className={p.activo ? undefined : "de-baja"}>
                  <td className="num">{p.orden}</td>
                  <td>
                    <div className="titulo-fila">{p.direccion}</div>
                    {p.nombre && <div className="sub-fila">{p.nombre}</div>}
                  </td>
                  <td>{p.horario ?? "—"}</td>
                  <td>
                    <span className={`chip ${p.activo ? "ok" : "pend"}`}>
                      {p.activo ? "activo" : "inactivo"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="ayuda" style={{ maxWidth: "74ch" }}>
          Cuando Migue arma esta lista usa la dirección, el horario y las observaciones. El nombre,
          el tipo y los materiales están cargados y no se usan: un vecino que pregunta por
          neumáticos recibe los primeros cinco por orden, no los que aceptan neumáticos.
        </p>
      </section>

      {/* -------------------------------------------------------- Zonas --- */}

      <section style={{ marginTop: 30 }}>
        <h2>Zonas de recolección</h2>

        <div className="aviso atencion">
          <strong>Editar esto no cambiaría nada de lo que dice Migue.</strong>
          <div style={{ marginTop: 6 }}>
            El bot carga esta tabla y ningún paso la consulta. Los días y el horario que el vecino
            realmente lee están escritos dentro del mensaje de confirmación de retiro, que se edita
            en <Link href="/conocimiento">Conocimiento › Cómo habla Migue</Link>. Por eso la tabla
            se muestra de sólo lectura: un formulario que guarda un dato que no llega a nadie hace
            perder la confianza en toda la pantalla.
          </div>
        </div>

        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th>Zona</th>
                <th>Días</th>
                <th>Hora de sacar</th>
              </tr>
            </thead>
            <tbody>
              {zonas.map((z) => (
                <tr key={z.id} className={z.activo ? undefined : "de-baja"}>
                  <td>
                    <div className="titulo-fila">{z.nombre}</div>
                  </td>
                  <td>{z.dias.join(", ")}</td>
                  <td>{z.hora_sacar ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
