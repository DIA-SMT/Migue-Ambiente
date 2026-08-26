/**
 * Los cálculos de la pantalla Métricas.
 *
 * TODO se calcula acá, en TypeScript, sobre las filas que trae el server
 * component. No hay una vista `v_metricas` ni ningún agregado en SQL, y las dos
 * razones importan:
 *
 *   1. Los agregados de PostgREST están deshabilitados en este proyecto:
 *      `sum()`, `avg()` y `count()` agrupado devuelven 400 PGRST123. Lo único que
 *      funciona por HTTP es el count exacto con filtros y traer filas.
 *
 *   2. Y aunque funcionaran, no habría que usarlos. «Cerrado» ya está definido
 *      en `tipos.ts` —`estaCerrado()`— y cubierto por pruebas.
 *      Reimplementarlo en SQL para una vista es
 *      exactamente cómo nacieron los dos números contradictorios que este
 *      proyecto ya tuvo: la misma pantalla decía «20 abiertos» y «13 vencidos»
 *      sobre las mismas filas.
 *
 * Con 18 mensajes y 20 tickets traer todo es gratis. `LIMITE_FILAS` marca dónde
 * deja de serlo, y la pantalla avisa cuando se alcanza en vez de mentir por
 * omisión.
 */
import { estaCerrado, situacionSla, type Ticket } from "./tipos.ts";

/**
 * Cuántas filas se traen como máximo.
 *
 * No es un número mágico: es el punto donde conviene una vista con agregados en
 * la base. Cuando la pantalla lo alcance va a decirlo, porque un total calculado
 * sobre las últimas N filas y presentado como «el total» es una mentira
 * silenciosa — y ya pasó acá, con un resumen que se recalculaba sobre las
 * últimas 200 conversaciones y bajaba sin que nadie hubiera arreglado nada.
 */
export const LIMITE_FILAS = 5000;

/**
 * A partir de cuántas observaciones un porcentaje dice algo.
 *
 * Por debajo, la pantalla muestra el crudo —«2 de 3»— y no un porcentaje. Un
 * «67% le sirvió» sobre tres turnos parece una medición y no lo es.
 *
 * Treinta es la convención habitual para que una proporción tenga un intervalo
 * de confianza manejable. No es exacto para nada; es un umbral honesto.
 */
export const MINIMO_PARA_PORCENTAJE = 30;

export interface MensajeMedido {
  direccion: "entrante" | "saliente";
  intencion: string | null;
  confianza: number | null;
  origen_respuesta: string | null;
  modelo: string | null;
  tokens_entrada: number | null;
  tokens_salida: number | null;
  costo_usd: number | null;
  latencia_ms: number | null;
  fragmentos_citados: string[] | null;
  conversacion_id: string;
  creado_en: string;
}

export interface ConversacionMedida {
  id: string;
  canal: string;
  canal_usuario_id: string;
  estado: string;
  cantidad_mensajes: number;
  iniciada_en: string;
  ultima_actividad_en: string;
}

/* ------------------------------------------------------------- alcance --- */

/**
 * A cuánta gente atendió Migue, que es la pregunta previa a todas las demás.
 *
 * Hoy la respuesta es UNA persona, y es la cuenta de desarrollo. Mientras sea
 * así, ninguna tasa de esta pantalla describe a un vecino: describe a quien
 * probó el bot. La pantalla lo dice arriba de todo en vez de mostrar
 * porcentajes, porque un número con forma de medición se lee como una medición.
 */
export interface Alcance {
  readonly personas: number;
  readonly conversaciones: number;
  readonly turnos: number;
  /** Conversaciones con actividad dentro de la ventana de sesión. */
  readonly vivas: number;
  /**
   * Abiertas sin actividad reciente.
   *
   * Una conversación sólo se marca «abandonada» cuando la MISMA persona escribe
   * de nuevo: el estado del flujo vive en Redis con TTL y al vencer no toca la
   * base, y no hay ningún barrido programado. Así que «abiertas» no es una
   * medida de actividad, es un cementerio que crece. Se cuentan aparte para que
   * la pantalla no las presente como gente esperando respuesta.
   */
  readonly abiertasSinVolver: number;
  readonly desde: string | null;
  readonly hasta: string | null;
}

export function medirAlcance(
  conversaciones: readonly ConversacionMedida[],
  mensajes: readonly MensajeMedido[],
  ventanaHoras: number,
  ahora: number,
): Alcance {
  const personas = new Set(conversaciones.map((c) => `${c.canal}:${c.canal_usuario_id}`));
  const corte = ahora - ventanaHoras * 3_600_000;
  const abiertas = conversaciones.filter((c) => c.estado === "abierta");
  const vivas = abiertas.filter((c) => new Date(c.ultima_actividad_en).getTime() > corte);

  const fechas = conversaciones
    .map((c) => c.iniciada_en)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  return {
    personas: personas.size,
    conversaciones: conversaciones.length,
    turnos: mensajes.filter((m) => m.direccion === "entrante").length,
    vivas: vivas.length,
    abiertasSinVolver: abiertas.length - vivas.length,
    desde: fechas[0] ?? null,
    hasta: fechas.at(-1) ?? null,
  };
}

/* --------------------------------------------------------- lo que dijo --- */

/**
 * Cómo resolvió Migue cada respuesta.
 *
 * Se cuenta sobre los SALIENTES, no sobre los entrantes: la traza —intención,
 * confianza, modelo, costo— se guarda en el mensaje que el bot manda, no en el
 * que recibe. Los 9 entrantes de producción tienen la intención en null, así que
 * cualquier consulta que pregunte «de qué preguntaron» filtrando entrantes
 * devuelve vacío.
 */
export interface Reparto {
  readonly clave: string;
  readonly rotulo: string;
  readonly n: number;
  readonly tono: string;
}

const ORIGENES: Record<string, { rotulo: string; tono: string }> = {
  documentos: { rotulo: "con un documento", tono: "ok" },
  faq: { rotulo: "con una pregunta frecuente", tono: "ok" },
  respuesta_fija: { rotulo: "con una respuesta textual", tono: "ok" },
  flujo: { rotulo: "guiando un trámite", tono: "pend" },
  exclusion: { rotulo: "derivando a otra área", tono: "pend" },
  // El que importa: Migue no entendió y mostró el menú. Es la forma más
  // frecuente en que falla, y `sin_respuesta` no la registra.
  fallback: { rotulo: "sin entender: mostró el menú", tono: "alerta" },
};

export function repartoPorOrigen(mensajes: readonly MensajeMedido[]): Reparto[] {
  const salientes = mensajes.filter((m) => m.direccion === "saliente");
  const cuenta = new Map<string, number>();
  for (const m of salientes) {
    const k = m.origen_respuesta ?? "sin_dato";
    cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
  }
  return [...cuenta.entries()]
    .map(([clave, n]) => ({
      clave,
      rotulo: ORIGENES[clave]?.rotulo ?? clave,
      tono: ORIGENES[clave]?.tono ?? "pend",
      n,
    }))
    .sort((a, b) => b.n - a.n);
}

/* -------------------------------------------------------------- costo --- */

/**
 * Lo que costó, sabiendo que es un piso y no el total.
 *
 * `costo_usd` sale del campo que devuelve OpenRouter y cuando no lo manda queda
 * null. Hoy 5 de 9 salientes lo traen. Por eso se informa la cobertura al lado
 * del número: un total que dice «esto es lo que costó» cuando faltan cuatro
 * mensajes es un número que no se puede usar para presupuestar.
 *
 * Y no se promedia por mensaje saliente: la traza va sólo en el PRIMER saliente
 * del turno, así que dividir por todos los salientes divide por más mensajes de
 * los que costaron algo. Se divide por conversación, que es la unidad que le
 * importa al área.
 */
export interface Costo {
  readonly totalUsd: number;
  readonly conDato: number;
  readonly salientes: number;
  readonly porConversacion: number | null;
  readonly porModelo: readonly { modelo: string; usd: number; llamadas: number }[];
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
}

export function medirCosto(
  mensajes: readonly MensajeMedido[],
  conversaciones: number,
): Costo {
  const salientes = mensajes.filter((m) => m.direccion === "saliente");
  const conDato = salientes.filter((m) => m.costo_usd !== null);
  const totalUsd = conDato.reduce((n, m) => n + Number(m.costo_usd), 0);

  const porModelo = new Map<string, { usd: number; llamadas: number }>();
  for (const m of conDato) {
    const k = m.modelo ?? "sin modelo";
    const p = porModelo.get(k) ?? { usd: 0, llamadas: 0 };
    porModelo.set(k, { usd: p.usd + Number(m.costo_usd), llamadas: p.llamadas + 1 });
  }

  return {
    totalUsd,
    conDato: conDato.length,
    salientes: salientes.length,
    porConversacion: conversaciones > 0 ? totalUsd / conversaciones : null,
    porModelo: [...porModelo.entries()]
      .map(([modelo, v]) => ({ modelo, ...v }))
      .sort((a, b) => b.usd - a.usd),
    tokensEntrada: salientes.reduce((n, m) => n + (m.tokens_entrada ?? 0), 0),
    tokensSalida: salientes.reduce((n, m) => n + (m.tokens_salida ?? 0), 0),
  };
}

/* ----------------------------------------------------------- latencia --- */

export interface Latencia {
  readonly n: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly maximo: number | null;
}

/**
 * Percentiles, no promedio.
 *
 * Con una respuesta de 5,5 s y cuatro de 1 s, el promedio dice 2 s y ningún
 * vecino esperó 2 s. La mediana dice qué le pasa a la mitad y el p90 dice cuán
 * mal le va al que peor le va, que es lo que se puede accionar.
 */
export function medirLatencia(mensajes: readonly MensajeMedido[]): Latencia {
  const ms = mensajes
    .filter((m) => m.direccion === "saliente" && (m.latencia_ms ?? 0) > 0)
    .map((m) => m.latencia_ms as number)
    .sort((a, b) => a - b);

  if (ms.length === 0) return { n: 0, p50: null, p90: null, maximo: null };
  const en = (q: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))]!;
  return { n: ms.length, p50: en(0.5), p90: en(0.9), maximo: ms.at(-1)! };
}

/* ------------------------------------------------------------ tickets --- */

/**
 * Los tickets.
 *
 * Acá había un corte entre «heredado» y «del bot nuevo», porque la base traía 19
 * casos del bot anterior de ManyChat mezclados con los nuestros. Esos casos se
 * borraron —decisión del área: el bot viejo ya no existe— así que el corte se
 * fue con ellos. Todo lo que hay en esta tabla ahora es de este bot.
 *
 * Vale como nota para el futuro: mientras hubo mezcla, separar por CANAL era lo
 * correcto y separar por ESTADO daba mal. `esEstadoHeredado()` atrapaba 16 de los
 * 19 porque tres tenían estados que el panel también usa.
 */
export interface Casos {
  readonly total: number;
  readonly abiertos: number;
  readonly vencidos: number;
  readonly sinPlazo: number;
  readonly cerrados: number;
  /**
   * Cerrados con fecha de cierre. Si es 0 no se puede calcular ningún tiempo de
   * resolución, y la pantalla lo dice en lugar de mostrar un cero ambiguo.
   */
  readonly cerradosConFecha: number;
  readonly masViejoEnDias: number | null;
  readonly incompletos: number;
}

export function medirCasos(tickets: readonly Ticket[], ahora: number): Casos {
  const abiertos = tickets.filter((t) => !estaCerrado(t));
  const cerrados = tickets.filter((t) => estaCerrado(t));

  const edades = abiertos.map((t) =>
    Math.floor((ahora - new Date(t.created_at).getTime()) / 86_400_000),
  );

  return {
    total: tickets.length,
    abiertos: abiertos.length,
    vencidos: abiertos.filter((t) => situacionSla(t, ahora).urgencia === 0).length,
    sinPlazo: abiertos.filter((t) => t.sla_deadline === null).length,
    cerrados: cerrados.length,
    cerradosConFecha: cerrados.filter((t) => t.resolved_at !== null).length,
    masViejoEnDias: edades.length > 0 ? Math.max(...edades) : null,
    incompletos: tickets.filter(
      (t) => t.waste_type === null || t.address === null || t.photo_ref === null,
    ).length,
  };
}

/* ----------------------------------------------------------- corpus --- */

/**
 * Qué documentos usó Migue alguna vez.
 *
 * Es la métrica más útil que esta pantalla puede dar HOY, y la única que no
 * depende del volumen de tráfico: dice si sirvió cargar un PDF de 45 páginas. En
 * producción, 4 de 7 documentos nunca se citaron — dos de ellos son Planes
 * Rectores completos.
 *
 * Un documento sin citar no es necesariamente inútil: puede que nadie haya
 * preguntado de su tema todavía. Pero si un tema se pregunta y el documento que
 * lo cubre nunca aparece, ahí hay un problema de búsqueda, no de contenido.
 */
export interface Corpus {
  readonly documentos: number;
  readonly fragmentos: number;
  readonly fragmentosCitados: number;
  readonly nuncaCitados: readonly { id: string; titulo: string; fragmentos: number }[];
  readonly citados: readonly { id: string; titulo: string; veces: number }[];
}

export function medirCorpus(
  documentos: readonly { id: string; titulo: string; cantidad_fragmentos: number }[],
  fragmentosTotales: number,
  fragmentoADocumento: ReadonlyMap<string, string>,
  mensajes: readonly MensajeMedido[],
): Corpus {
  const vecesPorDocumento = new Map<string, number>();
  const fragmentosVistos = new Set<string>();

  for (const m of mensajes) {
    for (const idFragmento of m.fragmentos_citados ?? []) {
      fragmentosVistos.add(idFragmento);
      const doc = fragmentoADocumento.get(idFragmento);
      if (doc) vecesPorDocumento.set(doc, (vecesPorDocumento.get(doc) ?? 0) + 1);
    }
  }

  return {
    documentos: documentos.length,
    fragmentos: fragmentosTotales,
    fragmentosCitados: fragmentosVistos.size,
    nuncaCitados: documentos
      .filter((d) => !vecesPorDocumento.has(d.id))
      .map((d) => ({ id: d.id, titulo: d.titulo, fragmentos: d.cantidad_fragmentos })),
    citados: documentos
      .filter((d) => vecesPorDocumento.has(d.id))
      .map((d) => ({ id: d.id, titulo: d.titulo, veces: vecesPorDocumento.get(d.id)! }))
      .sort((a, b) => b.veces - a.veces),
  };
}

/* ------------------------------------------------------------- cola --- */

export interface Cola {
  readonly total: number;
  readonly pendientes: number;
  readonly tomados: number;
  readonly conError: number;
  readonly reintentados: number;
  readonly masViejoPendienteEnMinutos: number | null;
}

export function medirCola(
  trabajos: readonly {
    estado: string;
    intentos: number;
    error_detalle: string | null;
    creado_en: string;
  }[],
  ahora: number,
): Cola {
  const pendientes = trabajos.filter((t) => t.estado === "pendiente");
  const edades = pendientes.map((t) =>
    Math.floor((ahora - new Date(t.creado_en).getTime()) / 60_000),
  );
  return {
    total: trabajos.length,
    pendientes: pendientes.length,
    tomados: trabajos.filter((t) => t.estado === "tomado").length,
    conError: trabajos.filter((t) => t.estado === "error" || t.error_detalle !== null).length,
    reintentados: trabajos.filter((t) => t.intentos > 1).length,
    masViejoPendienteEnMinutos: edades.length > 0 ? Math.max(...edades) : null,
  };
}

/* ------------------------------------------------------- presentación --- */

/**
 * Un número y su denominador, o un porcentaje si el N alcanza.
 *
 * La regla: por debajo de `MINIMO_PARA_PORCENTAJE` se muestra el crudo. Un
 * «67%» sobre tres observaciones tiene la misma forma que un «67%» sobre tres
 * mil y no significa lo mismo, y quien lo lee no tiene cómo distinguirlos.
 */
export function proporcion(parte: number, total: number): string {
  if (total === 0) return "sin datos";
  if (total < MINIMO_PARA_PORCENTAJE) return `${parte} de ${total}`;
  return `${Math.round((parte / total) * 100)}% (${parte} de ${total})`;
}

/** Dólares con los decimales que hacen falta para que no se lea como cero. */
export function dolares(usd: number): string {
  if (usd === 0) return "US$ 0";
  if (usd < 0.01) return `US$ ${usd.toFixed(6)}`;
  return `US$ ${usd.toFixed(2)}`;
}

/** Milisegundos en algo que se lee. */
export function duracion(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Lo que esta pantalla NO puede medir hoy, y por qué.
 *
 * Es una sección de la pantalla y no una omisión, y la decisión es deliberada:
 * este proyecto ya se lastimó dos veces con números que no significaban lo que
 * parecían. Enumerar lo que falta evita que alguien pida una métrica y reciba
 * una respuesta fabricada, y deja escrito qué habría que cambiar para tenerla.
 */
export const NO_SE_PUEDE_MEDIR: readonly { que: string; porQue: string; paraTenerlo: string }[] = [
  {
    que: "Tiempo de resolución de un caso",
    porQue:
      "El único ticket cerrado no tiene fecha de cierre: viene del bot anterior y llegó con el " +
      "estado puesto. Inventarle una fecha sería fabricar un dato.",
    paraTenerlo:
      "Se resuelve solo con el tiempo: el panel sella `resolved_at` cuando alguien cierra un " +
      "caso desde acá, así que los nuevos sí lo van a tener.",
  },
  {
    que: "Cuánto tarda el área en tocar un caso por primera vez",
    porQue:
      "19 de los 20 tickets comparten el mismo `updated_at`, que es el instante en que corrió " +
      "una migración. Cualquier medida de «tocado hace cuánto» daría seis meses para todos.",
    paraTenerlo: "Hace falta registrar los cambios de estado, que hoy no se guardan en ninguna parte.",
  },
  {
    que: "En qué paso abandona la gente un trámite",
    porQue:
      "Al cerrar una conversación se ponen en null el flujo y el paso, así que se borra dónde se " +
      "cayó. Y el estado vive en Redis con vencimiento: cuando expira, la base no se entera.",
    paraTenerlo:
      "Guardar el último paso alcanzado antes de limpiar, o registrar el abandono cuando el " +
      "estado vence.",
  },
  {
    que: "Quién cambió una regla o un texto, y cuándo",
    porQue:
      "Las columnas de auditoría existen pero están vacías: las filas actuales se sembraron con " +
      "la clave del sistema, no editándolas desde el panel. No hay tabla de eventos.",
    paraTenerlo: "Se llena solo en cuanto alguien edite desde el panel: la acción ya guarda quién fue.",
  },
  {
    que: "Cuántas veces se usó cada respuesta textual, y en qué conversación",
    porQue:
      "`mensajes.respuesta_fija_id` se agregó para eso y ningún código la escribe. Sólo queda un " +
      "contador acumulado, sin fecha ni conversación.",
    paraTenerlo: "Escribir esa columna al enviar una respuesta textual.",
  },
];

/* ============================================================ portada === */

/*
 * Lo que sigue lo consume la portada, que es el tablero.
 *
 * Vive acá y no en la portada por la misma razón que todo lo demás en este
 * archivo: la pantalla de Métricas y el tablero tienen que decir lo MISMO. Dos
 * lugares que cuentan lo mismo con dos implementaciones es exactamente cómo
 * nacieron los dos números contradictorios que este proyecto ya tuvo.
 */

/**
 * La zona horaria en la que se agrupan los días.
 *
 * La VPS corre en UTC y Tucumán está en UTC-3. Agrupando por el día UTC, todo
 * lo que pasa después de las nueve de la noche cae en el día siguiente: un pico
 * del martes a las 22 h aparecería el miércoles. En una serie diaria eso no es
 * un detalle, es la diferencia entre ver el pico donde ocurrió y verlo corrido
 * un día.
 *
 * Argentina no aplica horario de verano desde 2009, así que retroceder de a
 * 86.400.000 ms cae siempre en el día local anterior. Si algún día volviera,
 * esta cuenta se saltearía o repetiría un día por año.
 */
export const ZONA = "America/Argentina/Tucuman";

/**
 * `en-CA` y no `es-AR`: el locale canadiense formatea AAAA-MM-DD, que es la
 * única forma que ordena bien como texto. `es-AR` daría «26/8/2026», y ordenado
 * alfabéticamente el 3 de marzo iría después del 26 de agosto.
 */
export function formateadorDeDia(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Un día de la serie. */
export interface Dia {
  /** `AAAA-MM-DD` en hora de Tucumán. */
  readonly fecha: string;
  /** Mensajes que escribió un vecino. Es la unidad de «interacción». */
  readonly turnos: number;
  /** Conversaciones que empezaron ese día. */
  readonly conversaciones: number;
  readonly costoUsd: number;
}

/**
 * La actividad día por día, con los días vacíos incluidos.
 *
 * Los ceros importan: una serie que sólo trae los días en que pasó algo
 * comprime los huecos, y dos picos separados por una semana se ven
 * consecutivos. El eje se arma completo y después se llena.
 */
export function serieDiaria(
  mensajes: readonly MensajeMedido[],
  conversaciones: readonly ConversacionMedida[],
  dias: number,
  ahora: number,
): Dia[] {
  const formato = formateadorDeDia();
  const casillas = new Map<string, { turnos: number; conversaciones: number; costoUsd: number }>();

  for (let i = dias - 1; i >= 0; i--) {
    casillas.set(formato.format(new Date(ahora - i * 86_400_000)), {
      turnos: 0,
      conversaciones: 0,
      costoUsd: 0,
    });
  }

  for (const m of mensajes) {
    const c = casillas.get(formato.format(new Date(m.creado_en)));
    if (!c) continue; // cae fuera de la ventana
    if (m.direccion === "entrante") c.turnos += 1;
    if (m.costo_usd !== null) c.costoUsd += Number(m.costo_usd);
  }

  for (const cv of conversaciones) {
    const c = casillas.get(formato.format(new Date(cv.iniciada_en)));
    if (c) c.conversaciones += 1;
  }

  return [...casillas.entries()].map(([fecha, v]) => ({ fecha, ...v }));
}

/* ------------------------------------------------------- de qué hablan --- */

export interface RepartoIntencion extends Reparto {
  /**
   * Si es un TEMA por el que el vecino escribió, o mecánica de la conversación.
   *
   * La distinción existe porque «de qué preguntan más» y «cuántos saludaron» no
   * son la misma pregunta, y un ranking que las mezcla suele estar encabezado
   * por «saludo» — que no le sirve a nadie para decidir nada.
   */
  readonly tema: boolean;
}

/**
 * Cada intención con su nombre en castellano.
 *
 * Las claves salen del catálogo del router (`Intencion` en el dominio) más las
 * que escribe el manejo del voto, que no pasan por el clasificador. Una clave
 * que no esté acá se muestra igual, cruda: si alguien agrega una intención en
 * el bot, la portada la tiene que mostrar aunque nadie haya tocado este archivo.
 */
const INTENCIONES: Record<string, { rotulo: string; tono: string; tema: boolean }> = {
  retiro_no_habitual: { rotulo: "Retiro de residuos no habituales", tono: "ok", tema: true },
  reclamo_recoleccion: { rotulo: "Reclamo por recolección", tono: "ok", tema: true },
  programa_separa: { rotulo: "Programa SEPARÁ", tono: "ok", tema: true },
  programa_educa: { rotulo: "Programa EDUCÁ", tono: "ok", tema: true },
  programa_transforma: { rotulo: "Programa TRANSFORMÁ", tono: "ok", tema: true },
  consulta_libre: { rotulo: "Consulta ambiental", tono: "ok", tema: true },
  fuera_de_alcance: { rotulo: "No es de Ambiente", tono: "curso", tema: true },
  saludo: { rotulo: "Saludo", tono: "pend", tema: false },
  despedida: { rotulo: "Despedida", tono: "pend", tema: false },
  voto_util: { rotulo: "Votó que le sirvió", tono: "pend", tema: false },
  voto_no_util: { rotulo: "Votó que no le sirvió", tono: "pend", tema: false },
  no_entendido: { rotulo: "No entendió qué quería", tono: "alerta", tema: false },
};

/**
 * De qué le hablaron a Migue.
 *
 * Se cuenta sobre los mensajes que Migue ENVIÓ, no sobre los del vecino. No es
 * un capricho: la traza —intención, confianza, modelo— se guarda en el saliente.
 * Los entrantes tienen `intencion` en null, así que contar sobre ellos devuelve
 * vacío. Ya pasó.
 */
export function repartoPorIntencion(mensajes: readonly MensajeMedido[]): RepartoIntencion[] {
  const cuenta = new Map<string, number>();
  for (const m of mensajes) {
    if (m.direccion !== "saliente" || m.intencion === null) continue;
    cuenta.set(m.intencion, (cuenta.get(m.intencion) ?? 0) + 1);
  }

  return [...cuenta.entries()]
    .map(([clave, n]) => ({
      clave,
      rotulo: INTENCIONES[clave]?.rotulo ?? clave,
      tono: INTENCIONES[clave]?.tono ?? "pend",
      tema: INTENCIONES[clave]?.tema ?? true,
      n,
    }))
    .sort((a, b) => b.n - a.n || a.clave.localeCompare(b.clave));
}

/* -------------------------------------------------------------- votos --- */

/** Las columnas de voto de `v_conversaciones`. */
export interface VotosDeConversacion {
  readonly votos_utiles: number;
  readonly votos_no_utiles: number;
  readonly votos_respuesta_mala: number;
  readonly votos_tramite_dificil: number;
}

export interface Votos {
  readonly utiles: number;
  readonly noUtiles: number;
  /** De los pulgares abajo, los que califican una RESPUESTA. Se arregla escribiendo. */
  readonly respuestaMala: number;
  /** De los pulgares abajo, los que dicen que el TRÁMITE fue complicado. Se arregla sacando un paso. */
  readonly tramiteDificil: number;
  readonly total: number;
}

/**
 * Los pulgares, sumados.
 *
 * `respuestaMala` y `tramiteDificil` NO se suman entre sí para dar `noUtiles`:
 * son dos preguntas distintas que el bot hace en momentos distintos, y un voto
 * viejo anterior a la separación puede no estar en ninguna de las dos. Sumarlas
 * y presentarlas como el total es la clase de cuenta que este proyecto ya pagó.
 */
export function medirVotos(conversaciones: readonly VotosDeConversacion[]): Votos {
  const suma = (f: (c: VotosDeConversacion) => number) =>
    conversaciones.reduce((n, c) => n + (Number(f(c)) || 0), 0);

  const utiles = suma((c) => c.votos_utiles);
  const noUtiles = suma((c) => c.votos_no_utiles);

  return {
    utiles,
    noUtiles,
    respuestaMala: suma((c) => c.votos_respuesta_mala),
    tramiteDificil: suma((c) => c.votos_tramite_dificil),
    total: utiles + noUtiles,
  };
}

/* -------------------------------------------------------------- pesos --- */

/**
 * A partir de cuántos días una cotización deja de describir el presente.
 *
 * Treinta es generoso para Argentina y ese es el punto: no es un umbral fino,
 * es el momento en que el tablero deja de presentar los pesos como si fueran de
 * hoy. Por debajo tampoco los presenta a ciegas — la cotización usada y su fecha
 * van SIEMPRE al lado del número.
 */
export const DIAS_PARA_COTIZACION_VIEJA = 30;

export interface Cotizacion {
  /** Pesos por dólar. 0 significa que nadie la cargó todavía. */
  readonly valor: number;
  readonly actualizadoEn: string | null;
  /**
   * Si alguien la editó desde el panel.
   *
   * La fila se siembra con la migración, y ahí `actualizado_en` es la fecha de
   * la migración pero `actualizado_por` queda en null. Sin esta distinción, una
   * fila recién sembrada se vería «actualizada hoy» sin que nadie haya mirado
   * un número.
   */
  readonly editadaPorAlguien: boolean;
}

export interface Cotizada {
  /** Si se puede convertir. Con `false` el tablero muestra sólo dólares. */
  readonly hay: boolean;
  readonly ars: number;
  readonly vieja: boolean;
  readonly dias: number | null;
}

/**
 * Dólares a pesos, diciendo siempre qué tan vieja es la cotización.
 *
 * Sin cotización no se inventa nada: `hay: false` y el tablero pide que se
 * cargue. Un número en pesos calculado con un valor por defecto inventado es
 * peor que no mostrar pesos, porque nadie sabría que es inventado.
 */
export function convertirAPesos(usd: number, c: Cotizacion, ahora: number): Cotizada {
  if (!(c.valor > 0)) return { hay: false, ars: 0, vieja: false, dias: null };

  const dias =
    c.actualizadoEn === null
      ? null
      : Math.floor((ahora - new Date(c.actualizadoEn).getTime()) / 86_400_000);

  return {
    hay: true,
    ars: usd * c.valor,
    // Sin fecha, o sin que nadie la haya revisado nunca, se trata como vieja: es
    // el lado seguro. Una cotización que nadie miró no es más confiable que una
    // de hace tres meses.
    vieja: !c.editadaPorAlguien || dias === null || dias >= DIAS_PARA_COTIZACION_VIEJA,
    dias,
  };
}

/**
 * Pesos, con el símbolo puesto a mano y no con `style: "currency"`.
 *
 * El formateo de moneda deja el símbolo, su posición y el tipo de espacio en
 * manos de la implementación de ICU, y la de Node no tiene por qué coincidir con
 * la del navegador. No hace falta averiguar si coinciden en cada versión: se
 * evita el problema. El agrupamiento de miles sí se delega, que es donde no hay
 * discusión —y es lo que ya usa `numero()` sin romper la hidratación—.
 *
 * Los decimales aparecen sólo por debajo de cien pesos. Arriba de eso son ruido:
 * a nadie le importan los centavos de un gasto de veinte mil.
 *
 * `decimales` fuerza la cantidad, y existe para UN caso: la cotización misma.
 * Un total de «$ 1.386» redondeado no le miente a nadie, pero mostrar la
 * cotización redondeada sí — el que rehaga la cuenta a mano con 1.386 no le va a
 * dar, porque el tablero multiplicó por 1385,5.
 */
export function pesos(ars: number, decimales = Math.abs(ars) < 100 ? 2 : 0): string {
  return `$ ${new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  }).format(ars)}`;
}
