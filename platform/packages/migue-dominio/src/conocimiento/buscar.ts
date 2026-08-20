/**
 * Búsqueda de conocimiento: respuestas fijas, FAQs y fragmentos de documentos.
 *
 * El orden de la cadena no es arbitrario, es una escala de confianza
 * decreciente:
 *
 *   1. Respuesta fija     texto exacto que escribió el área. Se envía SIN
 *                         pasar por el modelo.
 *   2. FAQ                respuesta escrita por un humano. El modelo la lee y
 *                         la adapta, pero el contenido ya fue revisado.
 *   3. Fragmento de PDF   documento institucional. El modelo tiene que
 *                         sintetizar, y ahí es donde puede equivocarse.
 *
 * Cuanto más arriba resuelve, menos margen hay para que el bot invente algo.
 */
import { obtenerCliente } from "../datos/cliente.ts";
import type { Catalogo, RespuestaFija } from "../datos/catalogo.ts";
import { contienePalabra, escaparRegex, normalizar } from "../texto.ts";

export type OrigenConocimiento = "faq" | "fragmento";

export interface Coincidencia {
  readonly origen: OrigenConocimiento;
  readonly id: string;
  readonly titulo: string | null;
  readonly texto: string;
  readonly documentoTitulo: string | null;
  readonly pagina: number | null;
  readonly rank: number;
  /** Vino del respaldo por similitud, no del texto completo. */
  readonly difuso: boolean;
}

// ---------------------------------------------------------------------------
// Respuestas fijas
// ---------------------------------------------------------------------------

/**
 * Busca una respuesta fija que aplique.
 *
 * Se evalúan por prioridad ascendente, y a igualdad se desempata por nombre
 * para que el resultado sea determinista. Sin ese desempate, dos respuestas con
 * la misma prioridad se resolverían según el orden en que Postgres devolvió las
 * filas, y un bot que contesta distinto al mismo mensaje es imposible de
 * depurar.
 */
export function buscarRespuestaFija(
  texto: string,
  catalogo: Catalogo,
): RespuestaFija | null {
  const ordenadas = [...catalogo.respuestasFijas].sort(
    (a, b) => a.prioridad - b.prioridad || a.nombre.localeCompare(b.nombre, "es"),
  );

  for (const fija of ordenadas) {
    if (coincide(texto, fija)) return fija;
  }
  return null;
}

function coincide(texto: string, fija: RespuestaFija): boolean {
  const norm = normalizar(texto);
  if (norm === "") return false;

  for (const disparador of fija.disparadores) {
    switch (fija.modo) {
      case "exacto":
        if (norm === normalizar(disparador)) return true;
        break;

      case "contiene":
        // Por palabra completa, no por substring: es la misma razón por la que
        // el motor de exclusiones no puede hacer que «gas» coincida con
        // «gasto».
        if (contienePalabra(norm, disparador)) return true;
        break;

      case "regex":
        // Los disparadores los carga un operador desde el panel. Una regex mal
        // escrita no puede tumbar el bot, así que se aísla el fallo y se sigue
        // con los demás disparadores.
        try {
          if (new RegExp(disparador, "iu").test(norm)) return true;
        } catch {
          // Regex inválida cargada en el panel: se ignora ese disparador.
          // Se prueba también como texto literal, que es lo que probablemente
          // quiso escribir quien la cargó.
          if (norm.includes(normalizar(escaparRegex(disparador)))) return true;
        }
        break;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// FAQs y fragmentos
// ---------------------------------------------------------------------------

export interface OpcionesBusqueda {
  /**
   * Términos de la expansión, separados por espacios.
   *
   * Van por separado y NO concatenados a la consulta: `websearch_to_tsquery`
   * une con AND, así que pegarlos haría la búsqueda más restrictiva en vez de
   * más amplia. La función los usa para armar una consulta OR aparte.
   */
  readonly terminos?: string | null;
  readonly limite?: number;
  readonly impulsoFaq?: number;
  readonly umbralDifuso?: number;
}

/**
 * Busca en FAQs y fragmentos con ranking unificado.
 *
 * La consulta la resuelve una función en la base (migración 014) porque
 * `ts_rank` no se puede usar para ordenar desde PostgREST, y porque el respaldo
 * difuso tiene que decidirse del lado del servidor: hacerlo en dos viajes
 * duplicaría la latencia mientras alguien espera respuesta en un chat.
 */
export async function buscarEnConocimiento(
  consulta: string,
  opciones: OpcionesBusqueda = {},
): Promise<Coincidencia[]> {
  if (normalizar(consulta) === "") return [];

  const { data, error } = await obtenerCliente().rpc("buscar_conocimiento", {
    p_consulta: consulta,
    p_terminos: opciones.terminos ?? null,
    p_limite: opciones.limite ?? 8,
    ...(opciones.impulsoFaq !== undefined ? { p_impulso_faq: opciones.impulsoFaq } : {}),
    ...(opciones.umbralDifuso !== undefined ? { p_umbral_difuso: opciones.umbralDifuso } : {}),
  });

  if (error) {
    throw new Error(`falló la búsqueda de conocimiento: ${error.message}`);
  }

  return (data ?? []).map(
    (f: Record<string, unknown>): Coincidencia => ({
      origen: f["origen"] as OrigenConocimiento,
      id: f["id"] as string,
      titulo: (f["titulo"] ?? null) as string | null,
      texto: f["texto"] as string,
      documentoTitulo: (f["documento_titulo"] ?? null) as string | null,
      pagina: (f["pagina"] ?? null) as number | null,
      rank: Number(f["rank"]),
      difuso: Boolean(f["difuso"]),
    }),
  );
}

/**
 * Arma el bloque de contexto que se le pasa al modelo.
 *
 * Cada fragmento va etiquetado con su procedencia para que el modelo pueda
 * citarla y para que, si contesta algo raro, se pueda rastrear de dónde salió.
 * Sin las etiquetas, una respuesta incorrecta es imposible de auditar.
 */
export function armarContexto(coincidencias: readonly Coincidencia[]): string {
  return coincidencias
    .map((c, i) => {
      const fuente =
        c.origen === "faq"
          ? "Pregunta frecuente del área"
          : [c.documentoTitulo, c.pagina !== null ? `pág. ${c.pagina}` : null]
              .filter(Boolean)
              .join(", ") || "Documento institucional";

      const encabezado = c.titulo ? `${fuente} — ${c.titulo}` : fuente;
      return `[${i + 1}] ${encabezado}\n${c.texto}`;
    })
    .join("\n\n");
}

/** Ids de las FAQs que se usaron, para incrementar su contador. */
export function idsDeFaqs(coincidencias: readonly Coincidencia[]): string[] {
  return coincidencias.filter((c) => c.origen === "faq").map((c) => c.id);
}

/**
 * ¿La búsqueda encontró algo lo bastante sólido para intentar responder?
 *
 * Un resultado difuso solo —que vino del respaldo por similitud— no alcanza:
 * significa que el texto completo no encontró nada y estamos adivinando por
 * parecido ortográfico. Con eso conviene registrar la pregunta como no
 * respondida antes que arriesgar un dato municipal equivocado.
 */
export function esMaterialSuficiente(coincidencias: readonly Coincidencia[]): boolean {
  if (coincidencias.length === 0) return false;
  return coincidencias.some((c) => !c.difuso);
}
