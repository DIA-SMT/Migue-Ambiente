import type { Dia } from "@/lib/metricas";

/**
 * Los gráficos del tablero.
 *
 * SVG y CSS escritos a mano, sin librería de charts, por el mismo motivo que los
 * iconos de `Botanica.tsx`: una librería trae un motor entero —escalas, ejes,
 * tooltips, animaciones— para dibujar dos formas, y llega con su propia idea de
 * tipografía y color que después hay que pelear para que se parezca al panel.
 * Acá son dos gráficos y cada uno usa la herramienta que le corresponde:
 *
 *   · La serie de tiempo va en SVG, porque es geometría: posiciones calculadas
 *     sobre un eje.
 *   · El ranking va en HTML con CSS, porque es TEXTO con una barra al lado. En
 *     SVG habría que medir a mano el ancho de cada rótulo para saber si entra, y
 *     «Retiro de residuos no habituales» no entra.
 */

/** Miles con punto, como se escriben acá. */
export function numero(n: number): string {
  return new Intl.NumberFormat("es-AR").format(n);
}

/**
 * `2026-08-26` a `26/8`.
 *
 * Se parte el texto en vez de construir un `Date`. `new Date("2026-08-26")` se
 * interpreta como medianoche UTC, que en Tucumán son las 21 del día anterior:
 * la fecha que `serieDiaria` calculó con todo cuidado en hora local se
 * retrocedería un día justo al momento de dibujar la etiqueta.
 */
function diaYMes(fecha: string): string {
  const [, mes, dia] = fecha.split("-");
  return `${Number(dia)}/${Number(mes)}`;
}

/* ============================================== la serie de actividad === */

const ANCHO = 720;
const ALTO = 170;
const IZQ = 34;
const DER = 10;
const ARRIBA = 14;
const ABAJO = 28;

export function SerieDeActividad({
  dias,
  etiqueta,
}: {
  dias: readonly Dia[];
  etiqueta: string;
}) {
  const total = dias.reduce((n, d) => n + d.turnos, 0);

  if (dias.length === 0 || total === 0) {
    return <div className="tarjeta vacio">Todavía no hubo actividad en esta ventana.</div>;
  }

  const pico = Math.max(...dias.map((d) => d.turnos));
  const anchoUtil = ANCHO - IZQ - DER;
  const altoUtil = ALTO - ARRIBA - ABAJO;
  const paso = anchoUtil / dias.length;
  // 0,62 del paso: deja respirar las barras sin que se conviertan en palitos.
  const anchoBarra = Math.max(2, paso * 0.62);

  // Cuántas etiquetas entran abajo sin encimarse. Con 30 días y ~40 px por
  // etiqueta, salen cinco. Se calcula en vez de fijarse para que la ventana
  // pueda cambiar de largo sin que el eje se apelmace.
  const cada = Math.max(1, Math.ceil(dias.length / Math.floor(anchoUtil / 46)));

  return (
    <svg
      className="grafico-serie"
      viewBox={`0 0 ${ANCHO} ${ALTO}`}
      role="img"
      aria-label={etiqueta}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Dos guías nada más: el piso y el pico. Una grilla completa sobre
          treinta barras chicas es más ruido que referencia. */}
      {[0, pico].map((v, i) => {
        const y = ARRIBA + altoUtil - (pico === 0 ? 0 : (v / pico) * altoUtil);
        return (
          <g key={v + "-" + i}>
            <line
              x1={IZQ}
              x2={ANCHO - DER}
              y1={y}
              y2={y}
              stroke="var(--linea)"
              strokeWidth="1"
            />
            <text x={IZQ - 7} y={y + 4} textAnchor="end" className="grafico-eje">
              {v}
            </text>
          </g>
        );
      })}

      {dias.map((d, i) => {
        const alto = pico === 0 ? 0 : (d.turnos / pico) * altoUtil;
        const x = IZQ + i * paso + (paso - anchoBarra) / 2;
        return (
          <g key={d.fecha}>
            {/* Una barra de cero no se dibuja, pero el día sigue ocupando su
                lugar en el eje: el hueco es el dato. */}
            {d.turnos > 0 && (
              <rect
                x={x}
                y={ARRIBA + altoUtil - alto}
                width={anchoBarra}
                height={alto}
                rx={Math.min(3, anchoBarra / 2)}
                fill="var(--verde-vivo)"
              >
                {/* Un SOLO hijo de texto, armado con plantilla.
                    Escrito como `{a}: {b} {c}` son cinco nodos de texto
                    contiguos, y React separa los nodos contiguos con comentarios
                    `<!-- -->` para poder reencontrar los límites al hidratar.
                    Adentro de un `<title>` el parser no los lee como
                    comentarios, así que el cliente ve un texto distinto del que
                    mandó el servidor y la hidratación falla. Apareció como
                    «Hydration failed» apuntando a esta línea. */}
                <title>{`${diaYMes(d.fecha)}: ${d.turnos} ${d.turnos === 1 ? "mensaje" : "mensajes"}`}</title>
              </rect>
            )}
            {i % cada === 0 && (
              <text
                x={IZQ + i * paso + paso / 2}
                y={ALTO - 9}
                textAnchor="middle"
                className="grafico-eje"
              >
                {diaYMes(d.fecha)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ======================================================== el ranking === */

export interface FilaRanking {
  readonly clave: string;
  readonly rotulo: string;
  readonly n: number;
  readonly tono: string;
}

/**
 * Un ranking de barras horizontales.
 *
 * Las barras se miden contra el MÁXIMO de la lista y no contra el total, y la
 * diferencia importa: con seis categorías parejas, medir contra el total deja
 * todas las barras en un sexto del ancho y el gráfico no muestra nada. Contra el
 * máximo, la primera llena el riel y el resto se lee en relación a ella, que es
 * la comparación que uno viene a hacer. El número exacto va al lado, así que no
 * se pierde la magnitud.
 */
export function Ranking({
  filas,
  total,
}: {
  filas: readonly FilaRanking[];
  total: number;
}) {
  if (filas.length === 0) {
    return <div className="tarjeta vacio">Todavía no hay nada que contar acá.</div>;
  }

  const pico = Math.max(...filas.map((f) => f.n));

  return (
    <ul className="ranking">
      {filas.map((f) => (
        <li key={f.clave}>
          <span className="rotulo">{f.rotulo}</span>
          <span className="riel">
            <span
              className={`relleno ${f.tono}`}
              style={{ width: `${pico === 0 ? 0 : Math.max(2, (f.n / pico) * 100)}%` }}
            />
          </span>
          <span className="n">
            {numero(f.n)}
            {total > 0 && <span className="pct">{Math.round((f.n / total) * 100)}%</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ========================================================== la torta === */

export interface PorcionTorta {
  readonly clave: string;
  readonly rotulo: string;
  readonly n: number;
  /** `true` para pintarla de alerta en vez de seguir la paleta categórica. */
  readonly esFalla?: boolean;
}

const RADIO = 62;
const GROSOR = 26;
const VUELTA = 2 * Math.PI * RADIO;

/**
 * Una torta con agujero, y el porqué de cada decisión.
 *
 * SE DIBUJA CON `stroke-dasharray` sobre un círculo, no con paths de arco. Un
 * arco en SVG se escribe con el comando `A`, que necesita calcular a mano los
 * puntos de inicio y fin con senos y cosenos, y tiene el caso especial del
 * `large-arc-flag` cuando una porción pasa la mitad de la vuelta. Un trazo
 * punteado sobre un círculo no tiene casos especiales: cada porción es un tramo
 * de raya, y una sola porción del 100% funciona sola.
 *
 * EL TEXTO NO VA ADENTRO. La leyenda es HTML al lado, por lo mismo que el
 * ranking: en SVG habría que medir a mano si «Retiro de residuos no habituales»
 * entra en la porción, y no entra. Adentro del agujero va sólo el total, que es
 * corto y siempre entra.
 *
 * LA PALETA es categórica y vale igual en los dos temas: son tonos medios
 * elegidos para distinguirse tanto sobre papel blanco como sobre papel oscuro.
 * La excepción es lo que se marca como falla, que se pinta de alerta: si «no
 * entendió» quedara del mismo verde que un tema, la torta escondería justo el
 * dato que hay que mirar.
 */
export function Torta({
  porciones,
  etiqueta,
  leyendaTotal,
}: {
  porciones: readonly PorcionTorta[];
  etiqueta: string;
  leyendaTotal: string;
}) {
  const total = porciones.reduce((n, p) => n + p.n, 0);

  if (total === 0) {
    return <div className="vacio">Todavía no hay nada que repartir acá.</div>;
  }

  // Se acumula el desplazamiento en lugar de calcularlo por índice: así los
  // redondeos no se van sumando y la última porción cierra la vuelta.
  let recorrido = 0;
  const tramos = porciones.map((p, i) => {
    const largo = (p.n / total) * VUELTA;
    const desde = recorrido;
    recorrido += largo;
    return {
      ...p,
      largo,
      desde,
      color: p.esFalla ? "var(--serie-alerta)" : `var(--cat-${(i % 8) + 1})`,
    };
  });

  return (
    <div className="torta">
      <svg
        className="torta-dibujo"
        viewBox="0 0 160 160"
        role="img"
        aria-label={etiqueta}
      >
        <g transform="rotate(-90 80 80)">
          {tramos.map((t) => (
            <circle
              key={t.clave}
              cx="80"
              cy="80"
              r={RADIO}
              fill="none"
              stroke={t.color}
              strokeWidth={GROSOR}
              strokeDasharray={`${t.largo} ${VUELTA - t.largo}`}
              strokeDashoffset={-t.desde}
            >
              <title>{`${t.rotulo}: ${numero(t.n)}`}</title>
            </circle>
          ))}
        </g>
        <text x="80" y="76" textAnchor="middle" className="torta-total">
          {numero(total)}
        </text>
        <text x="80" y="93" textAnchor="middle" className="torta-rotulo">
          {leyendaTotal}
        </text>
      </svg>

      <ul className="torta-leyenda">
        {tramos.map((t) => (
          <li key={t.clave}>
            <span className="marca" style={{ background: t.color }} />
            <span className="rotulo">{t.rotulo}</span>
            <span className="n">
              {numero(t.n)}
              <span className="pct">{Math.round((t.n / total) * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
