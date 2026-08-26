import Link from "next/link";
import type { PersonaDelPanel } from "@/lib/supabase-servidor";
import { Ranking, SerieDeActividad, numero } from "@/componentes/Graficos";
import {
  MINIMO_PARA_PORCENTAJE,
  convertirAPesos,
  dolares,
  medirAlcance,
  medirCasos,
  medirCosto,
  medirVotos,
  pesos,
  proporcion,
  repartoPorIntencion,
  repartoPorOrigen,
  serieDiaria,
  type ConversacionMedida,
  type Cotizacion,
  type MensajeMedido,
  type VotosDeConversacion,
} from "@/lib/metricas";
import { fechaLegible, type Ticket } from "@/lib/tipos";

/**
 * Cuántos días muestra la serie.
 *
 * Treinta y no siete: con siete, un fin de semana tranquilo se lee como una
 * caída. Y no noventa, porque a esa altura el gráfico deja de tener barras y
 * pasa a tener pelusa.
 */
const DIAS_DE_LA_SERIE = 30;

/**
 * El saludo, según la hora de Tucumán y no la del servidor.
 *
 * La VPS corre en UTC. Sin fijar la zona, a las nueve de la noche de Tucumán el
 * panel saludaría con un «buen día», porque en UTC ya pasó la medianoche.
 *
 * `hourCycle: "h23"` y no `hour12: false`: con `hour12` hay versiones de ICU que
 * devuelven «24» para la medianoche, y `24 < 13` es falso.
 *
 * Se lee con `formatToParts` en vez de parsear el texto formateado, que según el
 * locale puede venir como «09», «9» o «9 h».
 */
function saludo(ahora: Date): string {
  const partes = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Tucuman",
    hourCycle: "h23",
    hour: "numeric",
  }).formatToParts(ahora);

  const hora = Number(partes.find((p) => p.type === "hour")?.value ?? "12");

  if (hora < 13) return "Buen día";
  if (hora < 20) return "Buenas tardes";
  return "Buenas noches";
}

/** «3 casos vencidos», pero «1 caso vencido». */
function plural(n: number, uno: string, muchos: string): string {
  return n === 1 ? uno : muchos;
}

interface Pendiente {
  readonly cuanto: number;
  readonly que: string;
  readonly porQue: string;
  readonly adonde: string;
  readonly urgente: boolean;
}

/**
 * El tablero.
 *
 * Esta ruta fue durante mucho tiempo un `redirect` a Documentos, con un
 * comentario que decía que inventar un tablero con una sola sección construida
 * sería una pantalla vacía con aire de estar terminada. Era cierto entonces.
 *
 * El orden de las secciones responde a preguntas en orden de urgencia: qué me
 * está esperando, cuánta gente vino, de qué hablaron, cómo le fue a Migue,
 * cuánto costó. Lo accionable primero; lo que sólo describe, después.
 *
 * Todos los números salen de las funciones de `lib/metricas.ts`, las mismas que
 * usa la pantalla de Métricas. No hay UNA sola cuenta escrita en este archivo, y
 * es la regla más importante que tiene: esta base ya tuvo dos números
 * contradictorios sobre las mismas filas porque «cerrado» estaba definido en dos
 * lugares. Un tablero que discrepa con la pantalla de la que sale es peor que no
 * tener tablero.
 */
export function Portada({
  persona,
  ahora,
  conversaciones,
  mensajes,
  tickets,
  votosPorConversacion,
  preguntasPendientes,
  ventanaHoras,
  cotizacion,
  alcanzoElLimite,
  problema,
}: {
  persona: PersonaDelPanel;
  ahora: Date;
  conversaciones: readonly ConversacionMedida[];
  mensajes: readonly MensajeMedido[];
  tickets: readonly Ticket[];
  votosPorConversacion: readonly VotosDeConversacion[];
  preguntasPendientes: number;
  ventanaHoras: number;
  cotizacion: Cotizacion;
  alcanzoElLimite: boolean;
  problema: string | null;
}) {
  const ahoraMs = ahora.getTime();

  const alcance = medirAlcance(conversaciones, mensajes, ventanaHoras, ahoraMs);
  const serie = serieDiaria(mensajes, conversaciones, DIAS_DE_LA_SERIE, ahoraMs);
  const intenciones = repartoPorIntencion(mensajes);
  const origenes = repartoPorOrigen(mensajes);
  const costo = medirCosto(mensajes, alcance.conversaciones);
  const votos = medirVotos(votosPorConversacion);
  const casos = medirCasos(tickets, ahoraMs);

  // El costo llega de OpenRouter en dólares. Los pesos son una LECTURA de ese
  // número, no otro dato: por eso se convierten acá y no se guardan, y por eso
  // el dólar sigue siendo lo que se muestra grande.
  const enPesos = convertirAPesos(costo.totalUsd, cotizacion, ahoraMs);
  const porConversacionEnPesos = convertirAPesos(
    costo.porConversacion ?? 0,
    cotizacion,
    ahoraMs,
  );

  const salientes = mensajes.filter((m) => m.direccion === "saliente").length;
  const conIntencion = intenciones.reduce((n, i) => n + i.n, 0);
  const turnosEnLaSerie = serie.reduce((n, d) => n + d.turnos, 0);

  // Sólo el nombre de pila. «Buenas tardes, Matías» es un saludo; con el nombre
  // completo es un encabezado de expediente.
  const nombre = persona.nombre?.trim().split(" ")[0];

  // Sólo entra lo que tiene algo esperando. Una tarjeta que dice «0 casos
  // vencidos» es una buena noticia la primera vez y ruido todas las demás.
  const pendientes: Pendiente[] = [];

  if (casos.vencidos > 0) {
    pendientes.push({
      cuanto: casos.vencidos,
      que: plural(casos.vencidos, "caso vencido", "casos vencidos"),
      porQue: "El plazo que Migue le prometió al vecino ya pasó.",
      adonde: "/casos",
      urgente: true,
    });
  }
  if (preguntasPendientes > 0) {
    pendientes.push({
      cuanto: preguntasPendientes,
      que: plural(preguntasPendientes, "pregunta sin responder", "preguntas sin responder"),
      porQue: "Migue no supo qué contestar. Escribir la respuesta las cierra.",
      adonde: "/conocimiento",
      urgente: false,
    });
  }
  if (casos.abiertos > 0) {
    pendientes.push({
      cuanto: casos.abiertos,
      que: plural(casos.abiertos, "caso abierto", "casos abiertos"),
      porQue: "Pedidos y reclamos que todavía no se resolvieron.",
      adonde: "/casos",
      urgente: false,
    });
  }

  return (
    <main>
      {/* ------------------------------------------------------- el saludo --- */}

      <section className="portada-hola">
        <div className="dicho">
          <h1>
            {saludo(ahora)}
            {nombre ? `, ${nombre}` : ""}
          </h1>
          <p>
            Cómo viene Migue, el asistente que contesta las consultas ambientales de los vecinos.
          </p>

          <div className="portada-cifras">
            <div>
              <span className="n">{numero(alcance.turnos)}</span>
              <span className="r">Mensajes de vecinos</span>
            </div>
            <div>
              <span className="n">{numero(alcance.conversaciones)}</span>
              <span className="r">Conversaciones</span>
            </div>
            <div>
              <span className="n">{numero(alcance.personas)}</span>
              <span className="r">{plural(alcance.personas, "Persona", "Personas")}</span>
            </div>
            <div>
              <span className="n">{dolares(costo.totalUsd)}</span>
              {enPesos.hay && <span className="eq">≈ {pesos(enPesos.ars)}</span>}
              <span className="r">Gastado en IA</span>
            </div>
          </div>
        </div>

        {/* `img` y no `next/image`: el optimizador de Next exige `sharp`
            instalado en la VPS y acá no compraría nada — el archivo ya está en
            el tamaño en que se muestra. Los atributos de tamaño van igual, para
            que el navegador reserve el lugar y la tarjeta no salte al cargar.

            WebP y no PNG: son 73 kB contra 302 kB por el mismo dibujo con la
            misma transparencia. Nginx proxea todo a Next, así que el tipo MIME
            lo pone Next y no hay que tocar el servidor.

            `alt` vacío y `aria-hidden`: es un dibujo, no información. */}
        <img src="/marca/migue.webp" alt="" aria-hidden="true" width={362} height={600} />
      </section>

      {problema && <div className="aviso mal">No pude leer todo: {problema}</div>}

      {/* -------------------------------------- de cuánto estamos hablando --- */}

      {alcance.personas <= 1 ? (
        <div className="aviso-muestra">
          <div>
            <strong>Todo lo que se ve acá es tráfico de prueba.</strong>
            Migue atendió a {alcance.personas === 0 ? "nadie" : "una sola persona"} hasta ahora, así
            que ningún porcentaje de esta pantalla describe a un vecino: describe a quien probó el
            bot. Los números son correctos; lo que todavía no se puede es sacar conclusiones de
            ellos.
          </div>
        </div>
      ) : (
        alcance.turnos < MINIMO_PARA_PORCENTAJE && (
          <div className="aviso-muestra">
            <div>
              <strong>Muy pocos mensajes para concluir.</strong>
              Van {alcance.turnos} de vecinos, de {alcance.personas} personas. Los porcentajes se
              muestran igual, pero se mueven mucho con cada mensaje nuevo.
            </div>
          </div>
        )
      )}

      {alcanzoElLimite && (
        <div className="aviso atencion">
          Se alcanzó el límite de filas que trae esta pantalla. Los totales de abajo son de los
          últimos mensajes y no de todos: para pasar de acá hay que calcularlos en la base.
        </div>
      )}

      {/* ------------------------------------------ lo que está esperando --- */}

      <section className="tablero-seccion">
        <h2>Lo que está esperando</h2>
        <p className="bajada">Lo único de esta pantalla que le pide algo a alguien.</p>

        {pendientes.length === 0 ? (
          <div className="portada-al-dia">
            No hay nada esperando: ninguna pregunta sin responder y ningún caso abierto.
          </div>
        ) : (
          <div className="portada-atencion">
            {pendientes.map((p) => (
              <Link key={p.adonde + p.que} href={p.adonde} className={p.urgente ? "urgente" : ""}>
                <span className="n">{p.cuanto}</span>
                <span className="r">{p.que}</span>
                <span className="p">{p.porQue}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------ actividad --- */}

      <section className="tablero-seccion">
        <h2>Actividad de los últimos {DIAS_DE_LA_SERIE} días</h2>
        <p className="bajada">
          Cada barra es un día y mide los mensajes que <strong>escribió un vecino</strong>. Los días
          sin actividad se muestran vacíos y no se saltean: el hueco también es el dato.
        </p>
        <div className="tablero-caja">
          <SerieDeActividad
            dias={serie}
            etiqueta={`Mensajes de vecinos por día en los últimos ${DIAS_DE_LA_SERIE} días. Total del período: ${turnosEnLaSerie}.`}
          />
        </div>
      </section>

      {/* ---------------------------------------- de qué hablan y cómo fue --- */}

      <section className="tablero-seccion">
        <div className="tablero-par">
          <div className="tablero-caja">
            <h3>De qué le hablan a Migue</h3>
            <p className="ayuda">
              Se cuenta sobre lo que Migue <strong>respondió</strong>: la intención se guarda en su
              mensaje y no en el del vecino. En verde los temas; en gris la mecánica de la charla —
              saludos, despedidas, votos.
            </p>
            <Ranking filas={intenciones} total={conIntencion} />
          </div>

          <div className="tablero-caja">
            <h3>Cómo resolvió</h3>
            <p className="ayuda">
              De dónde salió cada respuesta. <strong>Sin entender: mostró el menú</strong> es la
              forma más común en que Migue falla, y no aparece en Sin responder: se arregla
              ajustando cómo clasifica, no escribiendo una respuesta.
            </p>
            <Ranking filas={origenes} total={salientes} />
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- plata y votos --- */}

      <section className="tablero-seccion">
        <div className="tablero-par">
          <div className="tablero-caja">
            <h3>Lo que cuesta</h3>
            <p className="ayuda">
              Es un <strong>piso</strong> y no el total: OpenRouter no siempre devuelve el costo, y
              cuando no lo manda queda en null. La cobertura va abajo.
            </p>

            <div className="plata">
              <div>
                <span className="n">{dolares(costo.totalUsd)}</span>
                {enPesos.hay && <span className="eq">≈ {pesos(enPesos.ars)}</span>}
                <span className="r">Total</span>
              </div>
              <div>
                <span className="n">
                  {costo.porConversacion === null ? "—" : dolares(costo.porConversacion)}
                </span>
                {costo.porConversacion !== null && porConversacionEnPesos.hay && (
                  <span className="eq">≈ {pesos(porConversacionEnPesos.ars)}</span>
                )}
                <span className="r">Por conversación</span>
              </div>
              <div>
                <span className="n">{numero(costo.tokensEntrada + costo.tokensSalida)}</span>
                <span className="r">Tokens</span>
              </div>
            </div>

            {/* La cotización usada va SIEMPRE con el número, nunca escondida.
                Pesos sin decir a qué dólar es un número que envejece en silencio:
                a los tres meses sigue viéndose igual de confiable y ya no lo es. */}
            {enPesos.hay ? (
              <p className={enPesos.vieja ? "aviso atencion" : "ayuda"}>
                {/* La cotización se muestra con sus decimales: es el número con
                    el que se multiplicó, y tiene que poder rehacerse a mano. */}
                Los pesos son a{" "}
                <strong>
                  {pesos(cotizacion.valor, Number.isInteger(cotizacion.valor) ? 0 : 2)} por dólar
                </strong>
                {cotizacion.actualizadoEn !== null && (
                  <>, cargado el {fechaLegible(cotizacion.actualizadoEn)}</>
                )}
                .{" "}
                {enPesos.vieja &&
                  (enPesos.dias === null || !cotizacion.editadaPorAlguien
                    ? "Nadie revisó ese valor todavía, así que tomalo como referencia y no como presupuesto. "
                    : `Hace ${enPesos.dias} días de eso: los pesos de arriba son a ese valor, no al de hoy. `)}
                Se cambia en <Link href="/reglas">Reglas</Link>.
              </p>
            ) : (
              <p className="ayuda">
                OpenRouter informa el costo en dólares. Para verlo también en pesos hay que cargar
                el tipo de cambio en <Link href="/reglas">Reglas</Link> — es la única regla de esa
                pantalla que no cambia nada de lo que recibe el vecino.
              </p>
            )}

            {costo.porModelo.length > 0 && (
              <Ranking
                filas={costo.porModelo.map((m) => ({
                  clave: m.modelo,
                  rotulo: m.modelo,
                  n: m.llamadas,
                  tono: "pend",
                }))}
                total={costo.conDato}
              />
            )}

            <p className="ayuda" style={{ marginTop: 12 }}>
              Traen el costo {proporcion(costo.conDato, costo.salientes)} de los mensajes enviados.
              Los tokens se reparten en {numero(costo.tokensEntrada)} de entrada y{" "}
              {numero(costo.tokensSalida)} de salida.
            </p>
          </div>

          <div className="tablero-caja">
            <h3>El voto del vecino</h3>
            <p className="ayuda">
              Migue pregunta dos cosas distintas: si la respuesta sirvió, y si el trámite resultó
              fácil. Se arreglan de maneras opuestas, así que se cuentan por separado.
            </p>

            {votos.total === 0 ? (
              <div className="vacio" style={{ padding: "24px 0" }}>
                Todavía nadie votó.
              </div>
            ) : (
              <>
                <div className="votos">
                  <div className="bien">
                    <span className="n">{numero(votos.utiles)}</span>
                    <span className="r">Le sirvió</span>
                  </div>
                  <div className="mal">
                    <span className="n">{numero(votos.noUtiles)}</span>
                    <span className="r">No le sirvió</span>
                  </div>
                </div>

                <p className="ayuda" style={{ marginTop: 12 }}>
                  De los pulgares abajo, {votos.respuestaMala}{" "}
                  {plural(votos.respuestaMala, "califica una respuesta", "califican una respuesta")}{" "}
                  y {votos.tramiteDificil} {plural(votos.tramiteDificil, "dice", "dicen")} que el
                  trámite fue complicado. <Link href="/conversaciones">Leer las conversaciones</Link>{" "}
                  es lo único que explica por qué.
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <p className="tablero-pie">
        Este tablero contesta <strong>cómo viene</strong>. Para saber si se puede confiar en un
        número —y qué cosas todavía no se pueden medir, con el motivo— está{" "}
        <Link href="/metricas">Métricas</Link>.
      </p>
    </main>
  );
}
