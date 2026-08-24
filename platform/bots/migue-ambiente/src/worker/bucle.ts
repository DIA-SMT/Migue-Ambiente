/**
 * El bucle del worker.
 *
 * Está separado del arranque para poder probarlo: recibe la cola y el reloj por
 * parámetro, así un test verifica que un trabajo que falla se cierra con error,
 * que la cola vacía no se consulta a máxima velocidad, y que un apagado no deja
 * un trabajo a medias.
 */
import {
  procesarTrabajo,
  type PuertosIngesta,
  type ResultadoTrabajo,
  type Trabajo,
} from "@migue/dominio/ingesta";

export interface Cola {
  /** Toma el próximo trabajo, o null si no hay. */
  tomar(worker: string): Promise<Trabajo | null>;
  /**
   * Cierra el trabajo. Sin error queda listo; con error vuelve a la cola si le
   * quedan intentos. `definitivo` corta los reintentos: es para los errores que
   * no cambian por insistir.
   */
  terminar(
    id: string,
    error?: string,
    definitivo?: boolean,
  ): Promise<{ estado: string; intentos: number }>;
  /** Devuelve a la cola los trabajos de workers que murieron. */
  recuperarColgados(): Promise<number>;
}

export interface OpcionesBucle {
  readonly worker: string;
  /** Espera entre consultas cuando la cola está vacía, en ms. */
  readonly esperaVacia?: number;
  /** Cada cuánto se buscan trabajos colgados, en ms. */
  readonly intervaloRecuperacion?: number;
  readonly dormir?: (ms: number) => Promise<void>;
  readonly ahora?: () => number;
  readonly registrar?: (nivel: "info" | "aviso" | "error", mensaje: string) => void;
}

/**
 * 3 segundos entre consultas con la cola vacía.
 *
 * Es un compromiso medido contra el costo: la latencia hasta Supabase es de unos
 * 40 ms, así que consultar cada 3 segundos son 28.800 consultas por día, que en
 * el plan gratuito no molestan. Bajarlo a 1 segundo triplicaría eso para ganar
 * dos segundos en la subida de un documento, que nadie mira con cronómetro.
 *
 * No se usa Realtime porque agregaría una conexión websocket permanente y un
 * modo de falla nuevo —la reconexión— para el mismo resultado.
 */
const ESPERA_VACIA = 3_000;

/**
 * Cada 5 minutos se buscan trabajos colgados.
 *
 * Un worker que muere a mitad de un trabajo lo deja en 'tomado' para siempre.
 * `recuperar_trabajos_colgados` los devuelve a la cola pasados 15 minutos, así
 * que revisar cada 5 alcanza y sobra.
 */
const INTERVALO_RECUPERACION = 5 * 60_000;

/**
 * La espera entre consultas a la cola.
 *
 * OJO con `unref()`: la primera versión lo llamaba sobre este temporizador,
 * pensando en que el proceso pudiera terminar sin esperar. El efecto real es el
 * opuesto de lo que se busca: un temporizador sin referencia no mantiene vivo
 * el bucle de eventos, así que con la cola VACÍA este `setTimeout` era lo único
 * pendiente, Node se quedaba sin trabajo y el proceso salía con código 0. PM2
 * lo reiniciaba, quedaba en bucle, y en los logs no había ni un error: sólo
 * «escuchando la cola» una y otra vez.
 *
 * El apagado rápido no lo da `unref`, lo da `cortarEspera`, que resuelve esta
 * promesa en el momento en que se pide el corte.
 */
const esperar = (ms: number): Promise<void> =>
  new Promise((resolver) => {
    setTimeout(resolver, ms);
  });

export interface Bucle {
  /** Corre hasta que se pida el apagado. */
  correr(): Promise<void>;
  /**
   * Pide el apagado y espera a que el bucle salga.
   *
   * Devuelve una promesa a propósito: `onShutdown` de @bots/core espera al
   * handler antes de llamar a `process.exit`, así que si esto resolviera de
   * inmediato el proceso podría morir con un trabajo en la mano. El trabajo
   * abandonado queda en 'tomado' y hay que esperar quince minutos a que lo
   * devuelva `recuperar_trabajos_colgados`.
   *
   * El presupuesto de cierre son 2500 ms. Si el trabajo en curso tarda más
   * —bajar un PDF grande con la red lenta— el proceso se va a cortar igual y el
   * barrido de colgados lo recupera. Es el caso raro y tiene red de contención;
   * lo que esto evita es el caso común, que es cortar el proceso mientras
   * escribe fragmentos en la base.
   */
  detener(): Promise<void>;
  /** Para diagnóstico y para los tests. */
  estadisticas(): { procesados: number; fallados: number };
}

export function crearBucle(
  cola: Cola,
  puertos: PuertosIngesta,
  opciones: OpcionesBucle,
): Bucle {
  const esperaVacia = opciones.esperaVacia ?? ESPERA_VACIA;
  const intervaloRecuperacion = opciones.intervaloRecuperacion ?? INTERVALO_RECUPERACION;
  const dormir = opciones.dormir ?? esperar;
  const ahora = opciones.ahora ?? (() => Date.now());
  const registrar = opciones.registrar ?? (() => {});

  let detenido = false;
  let procesados = 0;
  let fallados = 0;
  let ultimaRecuperacion = 0;

  // Se guarda el resolutor de la espera en curso para poder cortarla. Sin esto,
  // apagar con la cola vacía tarda lo que falte de los 3 segundos, y un deploy
  // que reinicia el worker sumaría esa demora sin necesidad.
  let cortarEspera: (() => void) | null = null;
  let finDelBucle: (() => void) | null = null;
  // Si el bucle ya salió, `detener()` no puede quedarse esperando un aviso que
  // nunca va a llegar: el cierre se colgaría hasta agotar el presupuesto.
  let terminado = false;

  async function dormirInterrumpible(ms: number): Promise<void> {
    if (detenido) return;
    await new Promise<void>((resolver) => {
      cortarEspera = resolver;
      void dormir(ms).then(() => {
        cortarEspera = null;
        resolver();
      });
    });
  }

  async function cerrar(trabajo: Trabajo, resultado: ResultadoTrabajo): Promise<void> {
    if (resultado.ok) {
      await cola.terminar(trabajo.id);
      procesados++;
      registrar("info", `trabajo ${trabajo.tipo} listo: ${resultado.detalle}`);
      return;
    }

    fallados++;

    // La política de reintentos vive en `terminar_trabajo`; acá sólo se le
    // informa si el error es definitivo. Un PDF escaneado no mejora al tercer
    // intento, y mientras se reintenta vuelve a la cola y tapa a los que sí
    // pueden avanzar.
    const fila = await cola.terminar(trabajo.id, resultado.error, !resultado.reintentable);
    const nivel = fila.estado === "error" ? "error" : "aviso";
    registrar(
      nivel,
      `trabajo ${trabajo.tipo} falló (intento ${fila.intentos}, quedó ${fila.estado}): ${resultado.error}`,
    );
  }

  return {
    async correr(): Promise<void> {
      registrar("info", `worker ${opciones.worker} escuchando la cola`);

      while (!detenido) {
        // El barrido de colgados va antes de tomar: si este worker es el único
        // y murió en el intento anterior, esto es lo que devuelve su trabajo a
        // la cola para que lo tome ahora.
        if (ahora() - ultimaRecuperacion >= intervaloRecuperacion) {
          ultimaRecuperacion = ahora();
          try {
            const recuperados = await cola.recuperarColgados();
            if (recuperados > 0) {
              registrar("aviso", `${recuperados} trabajos colgados volvieron a la cola`);
            }
          } catch (error) {
            registrar("error", `falló el barrido de colgados: ${mensajeDe(error)}`);
          }
        }

        let trabajo: Trabajo | null;
        try {
          trabajo = await cola.tomar(opciones.worker);
        } catch (error) {
          // La base no responde. Se espera y se reintenta: el worker no tiene
          // que morirse porque hubo un corte de red de tres segundos.
          registrar("error", `no pude consultar la cola: ${mensajeDe(error)}`);
          await dormirInterrumpible(esperaVacia);
          continue;
        }

        if (trabajo === null) {
          await dormirInterrumpible(esperaVacia);
          continue;
        }

        try {
          const resultado = await procesarTrabajo(trabajo, puertos);
          await cerrar(trabajo, resultado);
        } catch (error) {
          // Acá sólo llegan los errores de `cola.terminar`, porque
          // `procesarTrabajo` ya atrapa lo suyo. Si no se puede cerrar el
          // trabajo, se deja en 'tomado' y lo recupera el barrido: es lo único
          // que se puede hacer sin base.
          fallados++;
          registrar("error", `no pude cerrar el trabajo ${trabajo.id}: ${mensajeDe(error)}`);
        }
      }

      registrar(
        "info",
        `worker ${opciones.worker} detenido (${procesados} listos, ${fallados} con falla)`,
      );
      terminado = true;
      finDelBucle?.();
    },

    detener(): Promise<void> {
      if (terminado) return Promise.resolve();
      if (detenido) return Promise.resolve();
      detenido = true;
      // Corta la espera si estaba durmiendo, para salir sin demora.
      cortarEspera?.();
      cortarEspera = null;
      return new Promise<void>((resolver) => {
        finDelBucle = resolver;
      });
    },

    estadisticas() {
      return { procesados, fallados };
    },
  };
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
