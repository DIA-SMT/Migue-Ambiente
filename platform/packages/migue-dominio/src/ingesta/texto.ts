/**
 * Limpieza del texto extraído de un documento.
 *
 * Todo acá son funciones puras, y todas resuelven problemas MEDIDOS sobre el
 * corpus real de Ambiente, no problemas hipotéticos.
 */

/**
 * Une las palabras cortadas por guion de división de sílabas.
 *
 * Los PDFs institucionales están justificados y cortan palabras al final de
 * línea: «Recolec-\nción», «educa-\nción», «contamina-\nción». Medido sobre el
 * corpus: 327 palabras cortadas en unas 11.300, entre 2% y 3%.
 *
 * El porcentaje suena bajo pero engaña, porque el corte cae en las palabras
 * LARGAS —que son las más distintivas para buscar—. Sin unirlas, un vecino que
 * pregunta por «recolección» no encuentra el párrafo que habla de recolección.
 *
 * No se unen los guiones que son parte de la palabra: en «Plan Rector
 * 2023-2030» o «SE-PA-RÁ» el guion no está al final de línea, así que no se
 * toca. La condición de fin de línea es lo que distingue un caso del otro.
 */
export function unirGuionesDeSilaba(texto: string): string {
  return (
    texto
      // Guion al final de línea, entre dos letras minúsculas: es corte de
      // sílaba. Se une sin dejar espacio.
      .replace(/([a-záéíóúüñ])-\n([a-záéíóúüñ])/g, "$1$2")
      // Mismo caso con la segunda parte en mayúscula, que aparece cuando el
      // corte cae antes de un nombre propio.
      .replace(/([a-záéíóúüñ])-\n([A-ZÁÉÍÓÚÜÑ])/g, "$1$2")
  );
}

/**
 * Quita los encabezados y pies que se repiten en cada página.
 *
 * Los PDFs del Plan Rector repiten «PROGRAMA CONTROLÁ | PLAN RECTOR 2023-2030
 * IR AL ÍNDICE IR AL INICIO» en las 43 páginas. Si eso queda, cada fragmento
 * arranca con la misma línea de ruido: infla el índice, y peor, un fragmento
 * puede ganar relevancia por coincidir con el encabezado y no con su contenido.
 *
 * Se detectan por REPETICIÓN y no por una lista: una línea que aparece en más
 * de la mitad de las páginas es un encabezado, sin importar qué diga. Así
 * funciona con cualquier documento que suban al panel, no sólo con estos tres.
 */
export function quitarRepetidos(paginas: readonly string[], umbral = 0.5): string[] {
  if (paginas.length < 4) return [...paginas];

  const conteo = new Map<string, number>();
  for (const pagina of paginas) {
    // Se cuenta una vez por página, aunque la línea se repita dentro de ella.
    const unicas = new Set(
      pagina
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length >= 8 && l.length <= 120),
    );
    for (const linea of unicas) conteo.set(linea, (conteo.get(linea) ?? 0) + 1);
  }

  const minimo = Math.ceil(paginas.length * umbral);
  const repetidas = new Set(
    [...conteo.entries()].filter(([, n]) => n >= minimo).map(([linea]) => linea),
  );

  if (repetidas.size === 0) return [...paginas];

  return paginas.map((pagina) =>
    pagina
      .split("\n")
      .filter((linea) => !repetidas.has(linea.trim()))
      .join("\n"),
  );
}

/**
 * Normaliza espacios y saltos sin destruir la estructura de párrafos.
 *
 * Los saltos dobles se conservan porque marcan el límite entre párrafos, y ese
 * límite es donde conviene cortar los fragmentos.
 */
export function normalizarEspacios(texto: string): string {
  return (
    texto
      // Espacios sin ruptura y otros invisibles que llegan de los PDFs
      .replace(/[   ]/g, " ")
      .replace(/[ \t]+/g, " ")
      // Tres o más saltos son un solo límite de párrafo
      .replace(/\n{3,}/g, "\n\n")
      .replace(/ +\n/g, "\n")
      .replace(/\n +/g, "\n")
      .trim()
  );
}

/**
 * Marca de título de sección.
 *
 * Los extractores etiquetan las líneas que SABEN que son títulos —en el PDF por
 * el tamaño de la tipografía, en el DOCX por el estilo del párrafo— con este
 * carácter de control al principio de la línea. El fragmentador confía en la
 * marca, y sólo cae en la heurística `pareceTitulo` cuando no hay ninguna.
 *
 * Es un carácter de control porque no puede aparecer en el texto de un
 * documento real: no hay forma de confundir contenido con marca. Se quita antes
 * de guardar, así que nunca llega a la base ni al vecino.
 */
export const MARCA_TITULO = "\u0001";

export function marcarTitulo(linea: string): string {
  return MARCA_TITULO + linea.trim();
}

export function esTituloMarcado(linea: string): boolean {
  return linea.startsWith(MARCA_TITULO);
}

export function quitarMarca(texto: string): string {
  return texto.split(MARCA_TITULO).join("");
}

/**
 * Tratamientos con los que arrancan las firmas de los documentos oficiales.
 *
 * Sirven para no confundir el nombre de una persona con un título de sección.
 * Van con el punto opcional porque aparecen de las dos formas.
 */
const TRATAMIENTOS =
  /^(dr|dra|lic|ing|arq|cr|cra|prof|sr|sra|srta|mg|esp|tec|t[eé]c)\.?\s+\p{Lu}/iu;

/**
 * ¿Esta línea parece un título de sección?
 *
 * Sirve para etiquetar los fragmentos con su sección, que es lo que después
 * permite citarle al vecino de dónde salió la respuesta.
 *
 * Heurística sobre tres señales: es corta, no termina en punto, y está en
 * mayúsculas o empieza con numeración. Ninguna sola alcanza —«RSU» es corto y
 * mayúscula pero no es un título— así que se piden al menos dos.
 */
export function pareceTitulo(linea: string): boolean {
  const limpia = linea.trim();
  if (limpia.length < 4 || limpia.length > 90) return false;
  if (/[.:;,]$/.test(limpia)) return false;

  const palabras = limpia.split(/\s+/);

  // ---- Señales suficientes por sí solas ----
  //
  // Numeración de sección. Es la señal más fuerte que existe en un documento
  // institucional: nadie empieza un párrafo con «1.». Fue el ajuste que hizo
  // falta al medir sobre el corpus: exigiendo dos señales, «1. Recolección
  // domiciliaria» no se detectaba, y los fragmentos terminaban etiquetados con
  // el título de la tapa en vez de con su sección real.
  if (/^(\d+[.)]|\d+\.\d+[.)]?|cap[íi]tulo\b|secci[óo]n\b|anexo\b)/i.test(limpia)) {
    return true;
  }

  // Todo en mayúsculas y con cuerpo suficiente. Se pide largo mínimo para no
  // tomar una sigla suelta —«RSU», «GPS»— como encabezado de sección.
  if (limpia === limpia.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3}/.test(limpia) && limpia.length >= 8) {
    return true;
  }

  // ---- Señal débil ----
  //
  // Frase corta y capitalizada sin verbos. Es la que rescata los títulos de los
  // borradores que llegan en Word sin estilos aplicados: «Flujo 1: Retiro no
  // tradicional», «Modulo Puntos Verdes», «Pruebas Bot». Sin ella esos
  // documentos quedan como un solo bloque sin secciones.
  //
  // Pero hay que descartar las FIRMAS, que en estos documentos son igual de
  // frecuentes que los títulos: cada PDF del Plan Rector tiene una página de
  // autoridades con «Dra. Rossana Chahla», «Ing. ...», «Lic. ...». El
  // tratamiento es la señal, y es la única forma barata de distinguir el
  // nombre de una persona de un título de sección.
  if (TRATAMIENTOS.test(limpia)) return false;

  const capitalizadas = palabras.filter((p) => /^[A-ZÁÉÍÓÚÑ]/.test(p)).length;
  const esFraseCorta = palabras.length <= 6 && capitalizadas >= 2;
  const sinVerbos = !/(?:es|son|está|están|tiene|hay|se|que|de la|del)/i.test(limpia);

  return esFraseCorta && sinVerbos;
}

/** Limpieza completa de un texto ya extraído, página por página. */
export function limpiar(paginas: readonly string[]): string[] {
  return quitarRepetidos(paginas).map((pagina) =>
    normalizarEspacios(unirGuionesDeSilaba(pagina)),
  );
}
