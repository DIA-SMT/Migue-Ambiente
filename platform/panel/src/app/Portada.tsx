import Link from "next/link";
import type { PersonaDelPanel } from "@/lib/supabase-servidor";
import { Ranking, SerieDeActividad, Torta, numero, type PorcionTorta } from "@/componentes/Graficos";
import { IconoMensajes, IconoPersonal, IconoPlata, IconoPulgar } from "@/componentes/Botanica";
import {
  MINIMO_PARA_PORCENTAJE,
  convertirAPesos,
  dolares,
  haceCuanto,
  medirAlcance,
  medirCanales,
  medirCasos,
  medirCosto,
  medirEntrantes,
  medirGasto,
  medirPunteria,
  medirVotos,
  pesos,
  proporcion,
  repartoPorIntencion,
  serieDiaria,
  ultimaActividad,
  type ConversacionMedida,
  type Cotizacion,
  type MensajeMedido,
  type VotosDeConversacion,
} from "@/lib/metricas";
import { fechaLegible, type Ticket } from "@/lib/tipos";

/**
 * Cuántos días muestra la serie.
 *
 * Treinta y no siete como el tablero de referencia: con siete, un fin de semana
 * tranquilo se lee como una caída. Y no noventa, porque a esa altura el gráfico
 * deja de tener barras y pasa a tener pelusa.
 */
const DIAS_DE_LA_SERIE = 30;

/** A partir de cuánto silencio se deja de mostrar el punto encendido. */
const HORAS_PARA_DORMIDO = 24;

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

const NOMBRE_DE_CANAL: Record<string, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

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
 * Contesta «cómo viene Migue» de un vistazo, en el orden en que uno se hace las
 * preguntas al abrirlo a la mañana: qué me está esperando, cuánta gente vino, de
 * qué hablaron, cómo le fue, cuánto costó. Lo accionable primero; lo que sólo
 * describe, después.
 *
 * DOS REGLAS QUE NO SE NEGOCIAN ACÁ.
 *
 * La primera: ni una cuenta se escribe en este archivo. Todos los números salen
 * de `lib/metricas.ts`, las mismas funciones que usa la pantalla de Métricas.
 * Esta base ya tuvo dos números contradictorios sobre las mismas filas porque
 * «cerrado» estaba definido en dos lugares.
 *
 * La segunda: cada cifra grande lleva abajo un renglón que dice qué NO mide.
 * «27 mensajes» y «27 personas» se ven igual de contundentes y significan cosas
 * muy distintas. Tres tarjetas de este tablero existirían igual sin ese
 * renglón, y las tres se leerían mal.
 *
 * Lo que NO está, y por qué: no hay «tasa de resolución» —resolver es que el
 * vecino se haya ido con su problema resuelto, y eso la base no lo sabe—, no
 * hay «audios transcritos» —el bot no transcribe nada— y no hay «en línea»
 * —no existe latido, y un bot sano en una noche tranquila se vería caído—.
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
  const entrantes = medirEntrantes(mensajes);
  const canales = medirCanales(conversaciones);
  const serie = serieDiaria(mensajes, conversaciones, DIAS_DE_LA_SERIE, ahoraMs);
  const intenciones = repartoPorIntencion(mensajes);
  const punteria = medirPunteria(mensajes);
  const costo = medirCosto(mensajes, alcance.conversaciones);
  const gasto = medirGasto(mensajes, ahoraMs);
  const votos = medirVotos(votosPorConversacion);
  const casos = medirCasos(tickets, ahoraMs);
  const senal = ultimaActividad(mensajes, ahoraMs);

  const gastoDelMesEnPesos = convertirAPesos(gasto.mesUsd, cotizacion, ahoraMs);
  const historicoEnPesos = convertirAPesos(gasto.historicoUsd, cotizacion, ahoraMs);

  // La torta lleva SÓLO los temas. Una que mezcle «Reclamo por recolección» con
  // «Saludo» y «Votó que le sirvió» queda encabezada por saludos, y con eso no
  // se decide nada. La mecánica se cuenta en un renglón abajo.
  const temas = intenciones.filter((i) => i.tema);
  const mecanica = intenciones.filter((i) => !i.tema);
  const totalMecanica = mecanica.reduce((n, i) => n + i.n, 0);
  const porciones: PorcionTorta[] = temas.map((t) => ({
    clave: t.clave,
    rotulo: t.rotulo,
    n: t.n,
    esFalla: t.tono === "alerta",
  }));

  const dormido = senal.haceMs === null || senal.haceMs > HORAS_PARA_DORMIDO * 3_600_000;
  const nombre = persona.nombre?.trim().split(" ")[0];

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
  if (votos.noUtiles > 0) {
    pendientes.push({
      cuanto: votos.noUtiles,
      que: plural(votos.noUtiles, "vecino dijo que no le sirvió", "vecinos dijeron que no les sirvió"),
      porQue: "Es lo único que mide si Migue está sirviendo de verdad.",
      adonde: "/clima",
      urgente: false,
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
      {/* --------------------------------------------------- el saludo --- */}

      <section className="portada-hola">
        <div className="dicho">
          <h1>
            {saludo(ahora)}
            {nombre ? `, ${nombre}` : ""}
          </h1>
          <p>
            Cómo viene Migue, el asistente que contesta las consultas ambientales de los vecinos.
          </p>

          {/* No dice «en línea». Dice cuándo fue lo último que pasó, que es lo
              único que la base sabe: no hay latido, y un bot sano en una noche
              sin consultas se vería igual que uno caído. */}
          <div className={`senal ${dormido ? "dormido" : ""}`}>
            <span className="punto" aria-hidden="true" />
            {senal.ultimoEn === null
              ? "Todavía no pasó ningún mensaje por Migue"
              : `Último mensaje ${haceCuanto(senal.haceMs)}`}
          </div>
        </div>

        {/* `img` y no `next/image`: el optimizador exige `sharp` en la VPS y no
            compraría nada, el archivo ya está en el tamaño en que se muestra.
            WebP: 73 kB contra 302 kB del PNG. `alt` vacío porque es un dibujo. */}
        <img src="/marca/migue.webp" alt="" aria-hidden="true" width={362} height={600} />
      </section>

      {problema && <div className="aviso mal">No pude leer todo: {problema}</div>}

      {/* ------------------------------------------- las cuatro cifras --- */}

      <div className="tarjetas-cifra">
        <div className="tarjeta-cifra">
          <IconoMensajes className="icono" />
          <span className="n">{numero(entrantes.escritos)}</span>
          <span className="r">Mensajes escritos por vecinos</span>
          <span className="p">
            {entrantes.toques > 0 || entrantes.conMedia > 0 ? (
              <>
                Aparte hubo {numero(entrantes.toques)} {plural(entrantes.toques, "toque", "toques")} de
                botón y {numero(entrantes.conMedia)} con foto o audio.
              </>
            ) : (
              "Los toques de botón se cuentan aparte: no son mensajes escritos."
            )}
          </span>
        </div>

        <div className="tarjeta-cifra tono-azul">
          <IconoPersonal className="icono" />
          <span className="n">{numero(alcance.personas)}</span>
          <span className="r">
            {plural(alcance.personas, "Identidad que escribió", "Identidades que escribieron")}
          </span>
          <span className="p">
            No son personas: la misma persona en Telegram y en WhatsApp cuenta dos veces, y no hay
            forma de saber que es la misma.
          </span>
          {canales.length > 0 && (
            <div className="canales">
              {canales.map((c) => (
                <span key={c.canal}>
                  {NOMBRE_DE_CANAL[c.canal] ?? c.canal} <strong>{numero(c.personas)}</strong>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className={`tarjeta-cifra ${votos.noUtiles > 0 ? "tono-alerta" : ""}`}>
          <IconoPulgar className="icono" />
          <span className="n">{numero(votos.total)}</span>
          <span className="r">{plural(votos.total, "Voto del vecino", "Votos de vecinos")}</span>
          <span className="p">
            {votos.total === 0 ? (
              "Nadie votó todavía. Es lo único que mide si Migue sirve."
            ) : (
              <>
                {numero(votos.utiles)} dijo que le sirvió, {numero(votos.noUtiles)} que no.{" "}
                <Link href="/clima">Ver el detalle</Link>.
              </>
            )}
          </span>
        </div>

        <div className="tarjeta-cifra tono-curso">
          <IconoPlata className="icono" />
          <span className="n">{dolares(gasto.mesUsd)}</span>
          {gastoDelMesEnPesos.hay && <span className="eq">≈ {pesos(gastoDelMesEnPesos.ars)}</span>}
          <span className="r">Gastado en IA en {gasto.etiquetaDelMes}</span>
          <span className="p">
            Acumulado: {dolares(gasto.historicoUsd)}
            {historicoEnPesos.hay ? ` (≈ ${pesos(historicoEnPesos.ars)})` : ""}. Es un piso, no el
            resumen de OpenRouter.
          </span>
        </div>
      </div>

      {/* ---------------------------------- de cuánto estamos hablando --- */}

      {alcance.personas <= 1 ? (
        <div className="aviso-muestra">
          <div>
            <strong>Todo lo que se ve acá es tráfico de prueba.</strong>
            Migue atendió a {alcance.personas === 0 ? "nadie" : "una sola identidad"} hasta ahora,
            así que ningún porcentaje de esta pantalla describe a un vecino: describe a quien probó
            el bot. Los números son correctos; lo que todavía no se puede es sacar conclusiones de
            ellos.
          </div>
        </div>
      ) : (
        alcance.turnos < MINIMO_PARA_PORCENTAJE && (
          <div className="aviso-muestra">
            <div>
              <strong>Muy pocos mensajes para concluir.</strong>
              Van {alcance.turnos} de vecinos, de {alcance.personas} identidades. Los porcentajes se
              muestran igual, pero se mueven mucho con cada mensaje nuevo.
            </div>
          </div>
        )
      )}

      {entrantes.audios > 0 && (
        <div className="aviso atencion">
          <strong>
            {numero(entrantes.audios)} {plural(entrantes.audios, "vecino mandó", "vecinos mandaron")}{" "}
            un audio y Migue no lo escuchó.
          </strong>{" "}
          El bot reconoce el audio y lo guarda, pero no lo transcribe: hoy no hay transcripción en
          ninguna parte del proyecto. Si este número crece, vale la pena agregarla.
        </div>
      )}

      {alcanzoElLimite && (
        <div className="aviso atencion">
          Se alcanzó el límite de filas que trae esta pantalla. Los totales de abajo son de los
          últimos mensajes y no de todos: para pasar de acá hay que calcularlos en la base.
        </div>
      )}

      {/* ---------------------------------------- lo que está esperando --- */}

      <section className="tablero-seccion">
        <h2>Lo que está esperando</h2>
        <p className="bajada">Lo único de esta pantalla que le pide algo a alguien.</p>

        {pendientes.length === 0 ? (
          <div className="portada-al-dia">
            No hay nada esperando: ningún voto negativo sin mirar, ninguna pregunta sin responder y
            ningún caso abierto.
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

      {/* ------------------------------------------------- la actividad --- */}

      <section className="tablero-seccion">
        <h2>Actividad de los últimos {DIAS_DE_LA_SERIE} días</h2>
        <p className="bajada">
          Cada barra es un día y mide lo que <strong>mandó un vecino</strong>, escrito o no. Los
          días sin actividad se muestran vacíos y no se saltean: el hueco también es el dato.
        </p>
        <div className="tablero-caja">
          <SerieDeActividad
            dias={serie}
            etiqueta={`Mensajes de vecinos por día en los últimos ${DIAS_DE_LA_SERIE} días.`}
          />
        </div>
      </section>

      {/* ------------------------------------- de qué hablan y cómo fue --- */}

      <section className="tablero-seccion">
        <div className="tablero-par">
          <div className="tablero-caja">
            <h3>De qué le hablan a Migue</h3>
            <p className="ayuda">
              Sólo los TEMAS. Los saludos, las despedidas y los votos van aparte: una torta que los
              mezcla queda encabezada por saludos, y con eso no se decide nada.
            </p>
            <Torta
              porciones={porciones}
              leyendaTotal="temas"
              etiqueta="Reparto de temas de los que le hablaron a Migue."
            />
            {totalMecanica > 0 && (
              <p className="ayuda" style={{ marginTop: 14, marginBottom: 0 }}>
                Aparte hubo {numero(totalMecanica)} de mecánica de la charla:{" "}
                {mecanica.map((m) => `${m.rotulo.toLowerCase()} (${m.n})`).join(", ")}.
              </p>
            )}
          </div>

          <div className="tablero-caja">
            <h3>Cómo le fue a Migue</h3>
            <p className="ayuda">
              Cuatro cifras y ningún promedio, a propósito. Mide si Migue{" "}
              <strong>encontró algo que decir</strong>, no si el vecino resolvió su trámite: lo
              segundo sólo lo dice el pulgar.
            </p>

            {punteria.decisiones === 0 ? (
              <div className="vacio" style={{ padding: "24px 0" }}>
                Todavía no tuvo que decidir nada.
              </div>
            ) : (
              <>
                <div className="punteria">
                  <div>
                    <span className="n">{numero(punteria.encontro)}</span>
                    <span className="r">Encontró qué contestar</span>
                  </div>
                  <div>
                    <span className="n">{numero(punteria.guio)}</span>
                    <span className="r">Guió un trámite</span>
                  </div>
                  <div>
                    <span className="n">{numero(punteria.derivo)}</span>
                    <span className="r">Derivó a otra área</span>
                  </div>
                  <div className={punteria.cayoAlMenu > 0 ? "mal" : ""}>
                    <span className="n">{numero(punteria.cayoAlMenu)}</span>
                    <span className="r">No entendió: mostró el menú</span>
                  </div>
                </div>
                <p className="ayuda" style={{ marginTop: 12, marginBottom: 0 }}>
                  Sobre {numero(punteria.decisiones)}{" "}
                  {plural(punteria.decisiones, "turno", "turnos")} en los que tuvo que decidir. Un
                  saludo o un «gracias» no cuentan: no son decisiones.
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- plata y voto --- */}

      <section className="tablero-seccion">
        <div className="tablero-par">
          <div className="tablero-caja">
            <h3>Lo que cuesta</h3>
            <p className="ayuda">
              Es un <strong>piso</strong> y no el resumen de OpenRouter: cuando no informa el costo
              de una respuesta, queda en null y no suma.
            </p>

            <div className="plata">
              <div>
                <span className="n">{dolares(gasto.mesUsd)}</span>
                {gastoDelMesEnPesos.hay && (
                  <span className="eq">≈ {pesos(gastoDelMesEnPesos.ars)}</span>
                )}
                <span className="r">{gasto.etiquetaDelMes}</span>
              </div>
              <div>
                <span className="n">{dolares(gasto.historicoUsd)}</span>
                {historicoEnPesos.hay && <span className="eq">≈ {pesos(historicoEnPesos.ars)}</span>}
                <span className="r">Acumulado</span>
              </div>
              <div>
                <span className="n">{numero(costo.tokensEntrada + costo.tokensSalida)}</span>
                <span className="r">Tokens</span>
              </div>
            </div>

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

            {gastoDelMesEnPesos.hay ? (
              <p
                className={gastoDelMesEnPesos.vieja ? "aviso atencion" : "ayuda"}
                style={{ marginTop: 12 }}
              >
                Los pesos son a{" "}
                <strong>
                  {pesos(cotizacion.valor, Number.isInteger(cotizacion.valor) ? 0 : 2)} por dólar
                </strong>
                {cotizacion.actualizadoEn !== null && (
                  <>, cargado el {fechaLegible(cotizacion.actualizadoEn)}</>
                )}
                .{" "}
                {gastoDelMesEnPesos.vieja &&
                  (gastoDelMesEnPesos.dias === null || !cotizacion.editadaPorAlguien
                    ? "Nadie revisó ese valor todavía, así que tomalo como referencia y no como presupuesto. "
                    : `Hace ${gastoDelMesEnPesos.dias} días de eso: los pesos de arriba son a ese valor, no al de hoy. `)}
                Se cambia en <Link href="/reglas">Reglas</Link>.
              </p>
            ) : (
              <p className="ayuda" style={{ marginTop: 12 }}>
                OpenRouter informa el costo en dólares. Para verlo también en pesos hay que cargar
                el tipo de cambio en <Link href="/reglas">Reglas</Link>.
              </p>
            )}
          </div>

          <div className="tablero-caja">
            <h3>El voto del vecino</h3>
            <p className="ayuda">
              Lo único de todo el tablero donde habla el vecino. El resto son inferencias nuestras.
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
                  Son dos preguntas distintas y se arreglan al revés: {votos.respuestaMala}{" "}
                  {plural(votos.respuestaMala, "califica una respuesta", "califican una respuesta")}{" "}
                  —se arregla escribiendo— y {votos.tramiteDificil}{" "}
                  {plural(votos.tramiteDificil, "dice", "dicen")} que el trámite fue complicado —se
                  arregla sacando un paso—.
                </p>
                <p className="ayuda" style={{ marginBottom: 0 }}>
                  En <Link href="/clima">Clima</Link> está cada pulgar abajo con lo que escribió el
                  vecino, que es lo único que explica por qué.
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <p className="tablero-pie">
        Este tablero contesta <strong>cómo viene</strong>. Para saber si se puede confiar en un
        número —y qué cosas todavía no se pueden medir, con el motivo— está{" "}
        <Link href="/metricas">Métricas</Link>. Hoy traen el costo{" "}
        {proporcion(costo.conDato, costo.salientes)} de los mensajes enviados.
      </p>
    </main>
  );
}
