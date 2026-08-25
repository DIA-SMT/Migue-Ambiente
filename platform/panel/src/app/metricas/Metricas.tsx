"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  dolares,
  duracion,
  medirAlcance,
  medirCasos,
  medirCola,
  medirCorpus,
  medirCosto,
  medirLatencia,
  MINIMO_PARA_PORCENTAJE,
  NO_SE_PUEDE_MEDIR,
  proporcion,
  repartoPorOrigen,
  type ConversacionMedida,
  type MensajeMedido,
} from "@/lib/metricas";
import { fechaLegible, type Ticket } from "@/lib/tipos";

/**
 * La pantalla de métricas.
 *
 * El orden no es por importancia técnica sino por honestidad: arriba va cuánta
 * gente usó el bot, porque es lo que le da o le quita sentido a todo lo de
 * abajo. Hoy es UNA persona, y es la cuenta de desarrollo. Mientras sea así,
 * ninguna tasa describe a un vecino, y la pantalla lo dice con esas palabras en
 * vez de mostrar un porcentaje que se leería como una medición.
 *
 * Después vienen las tres cosas que SÍ se pueden medir hoy con sentido:
 *
 *   Corpus   qué documentos usó Migue y cuáles nunca. Es la única métrica útil
 *            que no depende del volumen de tráfico.
 *   Herencia los 19 casos que dejó el bot anterior, que es trabajo real
 *            pendiente y no una medición del bot nuevo.
 *   Técnica  la cola, el costo, la latencia. Chico pero cierto.
 *
 * Y al final, lo que NO se puede medir, con el motivo de cada cosa. Es una
 * sección y no una omisión: este proyecto ya se lastimó dos veces con números
 * que no significaban lo que parecían, y enumerar lo que falta evita que alguien
 * pida una métrica y reciba una respuesta inventada.
 */
export function Metricas({
  conversaciones,
  mensajes,
  tickets,
  documentos,
  fragmentosTotales,
  fragmentoADocumento,
  trabajos,
  ventanaHoras,
  alcanzoElLimite,
}: {
  conversaciones: ConversacionMedida[];
  mensajes: MensajeMedido[];
  tickets: Ticket[];
  documentos: { id: string; titulo: string; cantidad_fragmentos: number }[];
  fragmentosTotales: number;
  fragmentoADocumento: [string, string][];
  trabajos: { estado: string; intentos: number; error_detalle: string | null; creado_en: string }[];
  ventanaHoras: number;
  alcanzoElLimite: boolean;
}) {
  // `ahora` en estado y no leído en el render: el servidor y el navegador
  // calcularían distinto las antigüedades y React avisaría de una discrepancia
  // de hidratación. Es el mismo patrón que usa la bandeja de casos.
  const [ahora, setAhora] = useState<number | null>(null);
  useEffect(() => setAhora(Date.now()), [mensajes.length, tickets.length]);

  const mapa = useMemo(() => new Map(fragmentoADocumento), [fragmentoADocumento]);

  const alcance = useMemo(
    () => medirAlcance(conversaciones, mensajes, ventanaHoras, ahora ?? Date.now()),
    [conversaciones, mensajes, ventanaHoras, ahora],
  );
  const reparto = useMemo(() => repartoPorOrigen(mensajes), [mensajes]);
  const costo = useMemo(() => medirCosto(mensajes, conversaciones.length), [mensajes, conversaciones]);
  const latencia = useMemo(() => medirLatencia(mensajes), [mensajes]);
  const casos = useMemo(() => medirCasos(tickets, ahora ?? Date.now()), [tickets, ahora]);
  const corpus = useMemo(
    () => medirCorpus(documentos, fragmentosTotales, mapa, mensajes),
    [documentos, fragmentosTotales, mapa, mensajes],
  );
  const cola = useMemo(() => medirCola(trabajos, ahora ?? Date.now()), [trabajos, ahora]);

  const sinPublicoReal = alcance.personas <= 1;
  const noEntendio = reparto.find((r) => r.clave === "fallback")?.n ?? 0;
  const salientes = reparto.reduce((n, r) => n + r.n, 0);

  return (
    <>
      {alcanzoElLimite && (
        <div className="aviso atencion">
          Se alcanzó el límite de filas que esta pantalla trae, así que los totales de abajo son
          parciales y no dicen «el total». A este volumen conviene mover los cálculos a una vista de
          la base.
        </div>
      )}

      {/* --------------------------------------------------- alcance --- */}

      <section>
        <h2>A cuánta gente atendió</h2>

        {sinPublicoReal ? (
          <div className="aviso atencion">
            <strong>
              {alcance.personas === 0
                ? "Migue todavía no habló con nadie."
                : "Todas las conversaciones son de una sola cuenta."}
            </strong>
            <div style={{ marginTop: 6 }}>
              {alcance.personas === 1 && (
                <>
                  Son {alcance.conversaciones} conversación
                  {alcance.conversaciones === 1 ? "" : "es"} y {alcance.turnos} mensaje
                  {alcance.turnos === 1 ? "" : "s"} de la misma persona — la cuenta con la que se
                  probó el bot.{" "}
                </>
              )}
              Mientras no haya vecinos distintos, cualquier porcentaje de esta pantalla describiría
              a quien probó el bot y no al público. Por eso abajo se muestran números crudos y no
              tasas: un porcentaje sobre menos de {MINIMO_PARA_PORCENTAJE} observaciones tiene la
              misma forma que uno sobre tres mil, y quien lo lee no puede distinguirlos.
            </div>
          </div>
        ) : (
          <div className="resumen">
            <div>
              <span className="n">{alcance.personas}</span>
              <span className="r">personas distintas</span>
            </div>
            <div>
              <span className="n">{alcance.conversaciones}</span>
              <span className="r">conversaciones</span>
            </div>
            <div>
              <span className="n">{alcance.turnos}</span>
              <span className="r">mensajes de vecinos</span>
            </div>
          </div>
        )}

        {alcance.abiertasSinVolver > 0 && (
          <p className="ayuda" style={{ maxWidth: "74ch" }}>
            {alcance.abiertasSinVolver} conversación
            {alcance.abiertasSinVolver === 1 ? " quedó" : "es quedaron"} abierta
            {alcance.abiertasSinVolver === 1 ? "" : "s"} sin actividad reciente. No cuentan como
            gente esperando: una charla sólo se marca cerrada cuando esa misma persona vuelve a
            escribir, así que «abiertas» acumula y no mide actividad.
          </p>
        )}
      </section>

      {/* -------------------------------------------- cómo respondió --- */}

      <section style={{ marginTop: 30 }}>
        <h2>Cómo resolvió cada respuesta</h2>
        <p className="bajada" style={{ marginTop: 4 }}>
          De dónde salió lo que Migue contestó. Se cuenta sobre los mensajes que{" "}
          <strong>envió</strong>: la intención y la confianza se guardan ahí, no en el mensaje del
          vecino.
        </p>

        {salientes === 0 ? (
          <div className="tarjeta vacio">Todavía no respondió nada.</div>
        ) : (
          <>
            <div className="envoltorio-tabla tarjeta">
              <table>
                <thead>
                  <tr>
                    <th>Resolvió</th>
                    <th className="num">Veces</th>
                    <th>Proporción</th>
                  </tr>
                </thead>
                <tbody>
                  {reparto.map((r) => (
                    <tr key={r.clave}>
                      <td>
                        <span className={`chip ${r.tono}`}>{r.rotulo}</span>
                      </td>
                      <td className="num">{r.n}</td>
                      <td>{proporcion(r.n, salientes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {noEntendio > 0 && (
              // El dato incómodo de esta sección, con el encuadre correcto.
              //
              // Una versión anterior de este cartel decía que estas fallas «no
              // aparecen en Sin responder» y que por eso «0 preguntas sin
              // responder puede convivir con fracasos reales». Era FALSO, y
              // conviene dejar escrito por qué para que no vuelva: con
              // `responder_antes_de_preguntar` activado, una consulta genuina no
              // puede terminar en el menú — el clasificador manda toda
              // `consulta_libre`, a cualquier confianza, a la cadena de
              // conocimiento, que sí registra. Se verificó corriendo el router
              // real.
              //
              // Y mirando los casos concretos de producción: los tres fueron un
              // `/start`, una elección de menú por número, y un mensaje que el
              // clasificador leyó mal. Ninguno es una pregunta que necesite una
              // respuesta escrita. Registrarlos habría llenado la lista de basura
              // y —peor— habría empujado a escribir una FAQ para arreglar un
              // problema de prompt.
              <div className="aviso atencion">
                <strong>
                  {noEntendio} de {salientes} veces Migue no entendió y mostró el menú.
                </strong>
                <div style={{ marginTop: 6 }}>
                  Esto mide la <strong>puntería del clasificador</strong>, no un hueco de
                  conocimiento. Un mensaje que no se entiende no llega a buscarse en los
                  documentos, así que tampoco aparece en{" "}
                  <Link href="/conocimiento">Sin responder</Link> — y no debería: el arreglo de un
                  mensaje mal entendido es ajustar cómo clasifica, no escribir una respuesta.
                </div>
                <div style={{ marginTop: 6 }}>
                  Cuando este número sube, conviene abrir las conversaciones y leer qué se le dijo:
                  si era una pregunta clara que el bot no ubicó, es un problema de clasificación.
                  Si eran comandos o números de menú, no es nada.
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* ---------------------------------------------------- corpus --- */}

      <section style={{ marginTop: 30 }}>
        <h2>Qué documentos usó</h2>
        <p className="bajada" style={{ marginTop: 4 }}>
          La única medida de esta pantalla que no depende de cuánta gente escribió: dice si sirvió
          cargar cada documento.
        </p>

        <div className="resumen">
          <div>
            <span className="n">
              {corpus.citados.length}
              <span style={{ fontSize: "0.5em", color: "var(--tinta-suave)" }}>
                {" "}
                / {corpus.documentos}
              </span>
            </span>
            <span className="r">documentos usados alguna vez</span>
          </div>
          <div>
            <span className="n">
              {corpus.fragmentosCitados}
              <span style={{ fontSize: "0.5em", color: "var(--tinta-suave)" }}>
                {" "}
                / {corpus.fragmentos}
              </span>
            </span>
            <span className="r">fragmentos citados</span>
          </div>
        </div>

        {corpus.nuncaCitados.length > 0 && (
          <>
            <p className="ayuda" style={{ maxWidth: "76ch" }}>
              Un documento sin usar no es necesariamente inútil: puede que nadie haya preguntado de
              su tema. Pero si el tema <em>sí</em> se pregunta y el documento nunca aparece,
              entonces el problema es la búsqueda y no el contenido — eso se prueba en{" "}
              <Link href="/conocimiento">Conocimiento</Link>, con el probador del buscador.
            </p>
            <div className="envoltorio-tabla tarjeta">
              <table>
                <thead>
                  <tr>
                    <th>Nunca se citó</th>
                    <th className="num">Fragmentos</th>
                  </tr>
                </thead>
                <tbody>
                  {corpus.nuncaCitados.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link className="enlace-tabla" href={`/documentos/${d.id}`}>
                          {d.titulo}
                        </Link>
                      </td>
                      <td className="num">{d.fragmentos}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {corpus.citados.length > 0 && (
          <div className="envoltorio-tabla tarjeta" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Sí se citó</th>
                  <th className="num">Fragmentos usados</th>
                </tr>
              </thead>
              <tbody>
                {corpus.citados.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link className="enlace-tabla" href={`/documentos/${d.id}`}>
                        {d.titulo}
                      </Link>
                    </td>
                    <td className="num">{d.veces}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* -------------------------------------------------- herencia --- */}

      <section style={{ marginTop: 30 }}>
        <h2>Pedidos y reclamos</h2>
        <p className="bajada" style={{ marginTop: 4 }}>
          Se separa por <strong>canal</strong> y no por estado. La diferencia es real: hay estados
          del bot anterior que el panel también usa, así que separando por estado tres casos viejos
          se contarían como gestión del bot nuevo.
        </p>

        <div className="resumen">
          <div>
            <span className="n">{casos.heredados}</span>
            <span className="r">del bot anterior</span>
          </div>
          <div>
            <span className="n">{casos.delBotNuevo}</span>
            <span className="r">de Migue</span>
          </div>
          <div>
            <span className="n" style={{ color: casos.vencidos > 0 ? "var(--alerta)" : undefined }}>
              {ahora === null ? "—" : casos.vencidos}
            </span>
            <span className="r">con el plazo vencido</span>
          </div>
        </div>

        {/* Un «13 vencidos» suelto se lee como un problema de Migue, y hoy es
            deuda del bot anterior. Verificado: los vencidos son todos de
            ManyChat y el único caso del bot nuevo está en plazo. */}
        {ahora !== null && casos.vencidos > 0 && casos.vencidos <= casos.heredados && (
          <p className="ayuda" style={{ maxWidth: "74ch" }}>
            Los {casos.vencidos} vencidos son casos del <strong>bot anterior</strong>, de febrero y
            marzo. No son plazos que Migue haya dejado pasar: son la deuda que había cuando
            arrancó.
          </p>
        )}

        <div className="tarjeta" style={{ padding: 16 }}>
          <dl className="ficha">
            <dt>Abiertos</dt>
            <dd>
              {casos.abiertos} de {casos.total}
              {casos.sinPlazo > 0 && (
                <span className="sub-fila"> · {casos.sinPlazo} sin plazo cargado</span>
              )}
            </dd>

            <dt>Más viejo</dt>
            <dd>
              {ahora === null || casos.masViejoEnDias === null
                ? "—"
                : `${casos.masViejoEnDias} días esperando`}
            </dd>

            <dt>Con datos incompletos</dt>
            <dd>
              {casos.incompletos} de {casos.total}
              <span className="sub-fila">
                {" "}
                · les falta foto, tipo de residuo o dirección
              </span>
            </dd>

            <dt>Cerrados</dt>
            <dd>
              {casos.cerrados}
              {casos.cerrados > 0 && casos.cerradosConFecha === 0 && (
                <div className="detalle-problema" style={{ marginTop: 4 }}>
                  Ninguno tiene fecha de cierre, así que no se puede calcular cuánto tardó en
                  resolverse. Los que se cierren desde el panel sí la van a tener.
                </div>
              )}
            </dd>
          </dl>
          <Link href="/casos">Ver la bandeja completa →</Link>
        </div>
      </section>

      {/* --------------------------------------------------- técnica --- */}

      <section style={{ marginTop: 30 }}>
        <h2>Costo y velocidad</h2>

        <div className="resumen">
          <div>
            <span className="n">{dolares(costo.totalUsd)}</span>
            <span className="r">gastado en el modelo</span>
          </div>
          <div>
            <span className="n">{duracion(latencia.p50)}</span>
            <span className="r">mediana de respuesta</span>
          </div>
          <div>
            <span className="n">{duracion(latencia.maximo)}</span>
            <span className="r">la más lenta</span>
          </div>
        </div>

        {costo.conDato < costo.salientes && (
          <p className="ayuda" style={{ maxWidth: "74ch" }}>
            El total es un <strong>piso</strong>: sólo {costo.conDato} de {costo.salientes} mensajes
            traen el costo. El proveedor no siempre lo informa, y los pasos de un trámite no cuestan
            nada porque no pasan por el modelo. No sirve para presupuestar todavía.
          </p>
        )}

        {costo.porModelo.length > 0 && (
          <div className="envoltorio-tabla tarjeta">
            <table>
              <thead>
                <tr>
                  <th>Modelo</th>
                  <th className="num">Llamadas</th>
                  <th className="num">Costo</th>
                </tr>
              </thead>
              <tbody>
                {costo.porModelo.map((m) => (
                  <tr key={m.modelo}>
                    <td>
                      <code>{m.modelo}</code>
                    </td>
                    <td className="num">{m.llamadas}</td>
                    <td className="num">{dolares(m.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="ayuda" style={{ maxWidth: "74ch" }}>
          {latencia.n > 0 && (
            <>
              Mediana y máximo en lugar de promedio: con una respuesta lenta y cuatro rápidas el
              promedio no describe a nadie. Medido sobre {latencia.n} llamada
              {latencia.n === 1 ? "" : "s"} al modelo
              {latencia.p90 !== null && `, p90 ${duracion(latencia.p90)}`}.
              {latencia.n < 10 && (
                <>
                  {" "}
                  Con {latencia.n} observacion{latencia.n === 1 ? "" : "es"} esto todavía no es una
                  mediana: son los tiempos que hubo. Los pasos de un trámite no cuentan acá porque
                  no llaman al modelo — no son respuestas rápidas, son respuestas que no midieron
                  nada.
                </>
              )}
            </>
          )}
        </p>
      </section>

      {/* ------------------------------------------------------ cola --- */}

      <section style={{ marginTop: 30 }}>
        <h2>Procesamiento de documentos</h2>
        <div className="tarjeta" style={{ padding: 16 }}>
          <dl className="ficha">
            <dt>Trabajos</dt>
            <dd>
              {cola.total} en total · {cola.pendientes} en espera · {cola.tomados} en curso
            </dd>
            <dt>Con error</dt>
            <dd>
              {cola.conError === 0 ? (
                "ninguno"
              ) : (
                <span className="chip alerta">{cola.conError}</span>
              )}
            </dd>
            <dt>Reintentados</dt>
            <dd>{cola.reintentados === 0 ? "ninguno" : cola.reintentados}</dd>
            {cola.masViejoPendienteEnMinutos !== null && (
              <>
                <dt>El pendiente más viejo</dt>
                <dd>
                  {cola.masViejoPendienteEnMinutos} min esperando
                  {cola.masViejoPendienteEnMinutos > 15 && (
                    <div className="detalle-problema" style={{ marginTop: 4 }}>
                      Más de 15 minutos en espera suele significar que el worker no está corriendo.
                    </div>
                  )}
                </dd>
              </>
            )}
          </dl>
        </div>
      </section>

      {/* ------------------------------------- lo que no se puede --- */}

      <section style={{ marginTop: 36 }}>
        <h2>Lo que todavía no se puede medir</h2>
        <p className="bajada" style={{ marginTop: 4 }}>
          Está acá y no omitido a propósito. Saber que un número no existe —y por qué— es tan útil
          como el número, y evita que alguien lo pida y reciba algo inventado.
        </p>

        {NO_SE_PUEDE_MEDIR.map((x) => (
          <div key={x.que} className="tarjeta" style={{ padding: 14, marginBottom: 10 }}>
            <div className="titulo-fila">{x.que}</div>
            <p className="ayuda" style={{ maxWidth: "78ch" }}>
              {x.porQue}
            </p>
            <div className="sub-fila" style={{ marginTop: 6 }}>
              Para tenerlo: {x.paraTenerlo}
            </div>
          </div>
        ))}
      </section>

      <p className="ayuda" style={{ marginTop: 24 }}>
        {alcance.desde !== null && (
          <>
            Datos desde {fechaLegible(alcance.desde)}
            {alcance.hasta !== null && ` hasta ${fechaLegible(alcance.hasta)}`}.{" "}
          </>
        )}
        Todo se calcula al abrir la pantalla, sobre las filas de la base: no hay ningún total
        precalculado que pueda quedar viejo.
      </p>
    </>
  );
}
