/**
 * Cálculo del plazo de resolución que el bot le promete al vecino.
 *
 * Esto es un compromiso institucional, no un adorno: el vecino organiza su
 * semana con esa fecha y el área queda medida contra ella.
 *
 * HALLAZGO DEL RELEVAMIENTO: el bot anterior calculaba `sla_deadline` como
 * "creado + 72 horas corridas". Un ticket creado el jueves 12/02/2026 a las
 * 12:00 quedó con vencimiento el DOMINGO 15/02 a las 12:00 — un plazo que cae
 * en un día en que la administración no atiende, para un servicio que la spec
 * describe como "72 horas hábiles".
 *
 * "72 horas hábiles" admite tres lecturas y la diferencia entre ellas es de
 * diez días, así que el modo es configurable y la decisión es de Ambiente:
 *
 *   dias_habiles    72/24 = 3 días hábiles      -> martes 17/02   (default)
 *   horas_corridas  72 horas de reloj           -> domingo 15/02  (lo anterior)
 *   horas_habiles   72 h de jornada laboral     -> miércoles 25/02
 *
 * El default es `dias_habiles` porque en el uso administrativo argentino
 * "72 horas hábiles" se entiende como tres días hábiles, y porque es la única
 * de las tres que da un plazo operativamente razonable para retirar residuos.
 */

export type ModoSla = "dias_habiles" | "horas_corridas" | "horas_habiles";

export interface ConfigSla {
  readonly modo: ModoSla;
  /** Horas del compromiso, tal como está cargado en `configuracion`. */
  readonly horas: number;
  /**
   * ¿El sábado cuenta como hábil?
   *
   * Para este servicio, sí por defecto: la recolección de Zona Sur trabaja los
   * sábados según el anexo de la spec. Es distinto del calendario
   * administrativo, y por eso es un parámetro y no una constante.
   */
  readonly sabadoEsHabil: boolean;
  /** Inicio de jornada, hora local. Sólo se usa en modo `horas_habiles`. */
  readonly jornadaDesde: number;
  /** Fin de jornada, hora local. Sólo se usa en modo `horas_habiles`. */
  readonly jornadaHasta: number;
  /** Feriados en formato YYYY-MM-DD, hora local. */
  readonly feriados: readonly string[];
}

export const CONFIG_SLA_POR_DEFECTO: ConfigSla = {
  modo: "dias_habiles",
  horas: 72,
  sabadoEsHabil: true,
  jornadaDesde: 8,
  jornadaHasta: 16,
  feriados: [],
};

/**
 * Desplazamiento horario de Tucumán respecto de UTC.
 *
 * Constante y no `Intl`: Argentina no aplica horario de verano desde 2009, así
 * que el offset es fijo. Una constante explícita es más fácil de auditar que
 * una conversión de zona horaria, y no depende de que la base de datos de
 * zonas del sistema esté actualizada.
 */
const OFFSET_HORAS = -3;

/** Partes de la fecha en hora local de Tucumán. */
function enLocal(fecha: Date): { dia: number; hora: number; iso: string } {
  const local = new Date(fecha.getTime() + OFFSET_HORAS * 3_600_000);
  return {
    dia: local.getUTCDay(), // 0 domingo .. 6 sábado
    hora: local.getUTCHours(),
    iso: local.toISOString().slice(0, 10),
  };
}

/** ¿Es día hábil según la configuración? */
export function esDiaHabil(fecha: Date, cfg: ConfigSla): boolean {
  const { dia, iso } = enLocal(fecha);
  if (dia === 0) return false;
  if (dia === 6 && !cfg.sabadoEsHabil) return false;
  return !cfg.feriados.includes(iso);
}

function estaEnJornada(fecha: Date, cfg: ConfigSla): boolean {
  if (!esDiaHabil(fecha, cfg)) return false;
  const { hora } = enLocal(fecha);
  return hora >= cfg.jornadaDesde && hora < cfg.jornadaHasta;
}

const UNA_HORA = 3_600_000;
const UN_DIA = 24 * UNA_HORA;

/**
 * Calcula el vencimiento del compromiso.
 *
 * Los tres modos avanzan hora a hora en lugar de hacer aritmética de
 * calendario. Es menos elegante pero maneja correctamente feriados
 * consecutivos y fines de semana largos sin casos especiales, y el volumen es
 * trivial: son 72 iteraciones como máximo por ticket.
 */
export function calcularVencimiento(desde: Date, cfg: ConfigSla): Date {
  switch (cfg.modo) {
    case "horas_corridas":
      return new Date(desde.getTime() + cfg.horas * UNA_HORA);

    case "dias_habiles": {
      const dias = Math.max(1, Math.round(cfg.horas / 24));
      let cursor = new Date(desde.getTime());
      let contados = 0;
      // Cota de seguridad: con feriados mal cargados esto podría no terminar.
      let vueltas = 0;
      while (contados < dias && vueltas < 400) {
        cursor = new Date(cursor.getTime() + UN_DIA);
        vueltas++;
        if (esDiaHabil(cursor, cfg)) contados++;
      }
      return cursor;
    }

    case "horas_habiles": {
      let cursor = new Date(desde.getTime());
      let contadas = 0;
      let vueltas = 0;
      while (contadas < cfg.horas && vueltas < 24 * 400) {
        cursor = new Date(cursor.getTime() + UNA_HORA);
        vueltas++;
        if (estaEnJornada(cursor, cfg)) contadas++;
      }
      return cursor;
    }
  }
}

/**
 * Texto del plazo para mostrarle al vecino.
 * Se mantiene aparte del cálculo para que el panel pueda cambiar la redacción
 * sin tocar la aritmética.
 */
export function describirPlazo(cfg: ConfigSla): string {
  switch (cfg.modo) {
    case "dias_habiles": {
      const dias = Math.max(1, Math.round(cfg.horas / 24));
      return `${dias} ${dias === 1 ? "día hábil" : "días hábiles"}`;
    }
    case "horas_corridas":
      return `${cfg.horas} horas`;
    case "horas_habiles":
      return `${cfg.horas} horas hábiles`;
  }
}

/** Formato dd/mm/yyyy en hora de Tucumán, para mostrarle la fecha al vecino. */
export function formatearFechaLocal(fecha: Date): string {
  const local = new Date(fecha.getTime() + OFFSET_HORAS * 3_600_000);
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${local.getUTCFullYear()}`;
}
