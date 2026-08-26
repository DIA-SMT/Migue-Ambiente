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
