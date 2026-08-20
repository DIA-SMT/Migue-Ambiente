/**
 * Corte del texto en fragmentos indexables.
 *
 * El fragmento es la unidad que se busca y que se le pasa al modelo, así que su
 * tamaño decide dos cosas opuestas: uno chico rankea preciso pero llega sin
 * contexto suficiente para responder; uno grande trae contexto pero diluye el
 * ranking, porque `ts_rank` divide por la cantidad de palabras del documento.
 *
 * Tres reglas gobiernan el corte:
 *
 *   1. Nunca se parte un párrafo al medio si se puede evitar. Una oración
 *      cortada no responde nada y aparece en los resultados igual.
 *   2. Un título de sección cierra el fragmento anterior. El contenido de dos
 *      secciones distintas mezclado en un fragmento hace que el modelo cite
 *      una sección hablando de otra.
 *   3. Los fragmentos SÍ pueden cruzar páginas. En los documentos
 *      institucionales los párrafos siguen de una página a la otra, y cortar
 *      ahí partiría oraciones por un límite tipográfico que al vecino no le
 *      dice nada.
 */
import { esTituloMarcado, pareceTitulo, quitarMarca } from "./texto.ts";

export interface FragmentoIndexable {
  readonly orden: number;
  readonly texto: string;
  /** Página donde EMPIEZA el fragmento. Un fragmento puede cruzar páginas. */
  readonly pagina: number | null;
  readonly tituloSeccion: string | null;
  readonly tokensAprox: number;
}

export interface OpcionesFragmentar {
  /** Tamaño buscado, en caracteres. */
  readonly objetivo?: number;
  /** Tope duro: por encima de esto se parte por oraciones. */
  readonly maximo?: number;
  /** Por debajo de esto no vale la pena indexar por separado. */
  readonly minimo?: number;
}

/**
 * 900 caracteres de objetivo, unas 150 palabras.
 *
 * Sale del tamaño de los párrafos del corpus: los documentos del Plan Rector
 * tienen párrafos de 400 a 700 caracteres, así que 900 junta dos párrafos
 * relacionados sin llegar a mezclar temas.
 */
const OBJETIVO = 900;
const MAXIMO = 1600;
const MINIMO = 80;

/** Estimación de tokens: en español, alrededor de 3,6 caracteres por token. */
function estimarTokens(texto: string): number {
  return Math.ceil(texto.length / 3.6);
}

/** Parte un bloque demasiado largo por límite de oración. */
function partirPorOraciones(bloque: string, maximo: number): string[] {
  const oraciones = bloque.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) ?? [bloque];
  const partes: string[] = [];
  let actual = "";

  for (const oracion of oraciones) {
    if (actual !== "" && actual.length + oracion.length > maximo) {
      partes.push(actual.trim());
      actual = "";
    }
    actual += oracion;

    // Una sola oración que ya excede el tope: se corta por palabras. Pasa con
    // enumeraciones largas sin puntuación.
    while (actual.length > maximo) {
      const corte = actual.lastIndexOf(" ", maximo);
      partes.push(actual.slice(0, corte > 0 ? corte : maximo).trim());
      actual = actual.slice(corte > 0 ? corte : maximo).trim();
    }
  }

  if (actual.trim() !== "") partes.push(actual.trim());
  return partes.filter((p) => p !== "");
}

interface Bloque {
  readonly texto: string;
  readonly pagina: number;
  readonly esTitulo: boolean;
}

/**
 * ¿Este bloque de una sola línea es un título?
 *
 * Si el extractor lo marcó, se confía en la marca sin discutir: sabe el tamaño
 * de la tipografía o el estilo del párrafo, que es información dura. La
 * heurística de texto queda sólo para lo que llega sin marcar.
 */
function esTitulo(linea: string): boolean {
  return esTituloMarcado(linea) || pareceTitulo(linea);
}

/** Convierte las páginas en bloques etiquetados, en orden de lectura. */
function aBloques(paginas: readonly string[]): Bloque[] {
  const bloques: Bloque[] = [];

  paginas.forEach((pagina, indice) => {
    const numero = indice + 1;
    for (const crudo of pagina.split(/\n{2,}/)) {
      const bloque = crudo.trim();
      if (bloque === "") continue;

      const lineas = bloque.split("\n");

      // Un bloque de una sola línea puede ser un título; se evalúa aparte para
      // que cierre el fragmento anterior.
      if (lineas.length === 1 && esTitulo(bloque)) {
        bloques.push({ texto: quitarMarca(bloque), pagina: numero, esTitulo: true });
        continue;
      }

      // Dentro de un bloque multilínea, la primera línea puede ser el título de
      // la sección y el resto su contenido.
      if (lineas.length > 1 && esTitulo(lineas[0]!)) {
        bloques.push({ texto: quitarMarca(lineas[0]!).trim(), pagina: numero, esTitulo: true });
        const resto = lineas.slice(1).join("\n").trim();
        if (resto !== "") {
          bloques.push({ texto: quitarMarca(resto), pagina: numero, esTitulo: false });
        }
        continue;
      }

      bloques.push({ texto: quitarMarca(bloque), pagina: numero, esTitulo: false });
    }
  });

  return bloques;
}

/**
 * ¿Este fragmento no vale la pena indexar?
 *
 * Dos casos, los dos medidos sobre el corpus:
 *
 * El índice. Los tres PDFs del Plan Rector tienen una tabla de contenidos con
 * puntos suspensivos, y es entre el 6% y el 7% del texto de cada uno. Es el peor
 * fragmento posible: enumera TODOS los títulos del documento, así que aparece
 * en los resultados de casi cualquier consulta y no contiene ni una respuesta.
 * El punteado es la señal, y es exacta: en el corpus no cae ningún fragmento de
 * contenido.
 *
 * La tapa y el colofón. «SAN MIGUEL DE TUCUMÁN / ROSSANA CHAHLA 2023», el ISBN,
 * el pie de imprenta. Son cortos y no responden nada, pero compiten en el
 * ranking igual.
 */
function descartable(texto: string, minimo: number): boolean {
  const lineas = texto.split("\n").filter((l) => l.trim() !== "");
  const conPunteado = lineas.filter((l) => /[.]{6,}/.test(l)).length;
  if (lineas.length > 0 && conPunteado / lineas.length >= 0.3) return true;

  return texto.length < minimo;
}

export function fragmentar(
  paginas: readonly string[],
  opciones: OpcionesFragmentar = {},
): FragmentoIndexable[] {
  const objetivo = opciones.objetivo ?? OBJETIVO;
  const maximo = opciones.maximo ?? MAXIMO;
  const minimo = opciones.minimo ?? MINIMO;

  const fragmentos: FragmentoIndexable[] = [];
  let acumulado: string[] = [];
  let paginaInicio: number | null = null;
  let seccion: string | null = null;

  const cerrar = (): void => {
    const texto = acumulado.join("\n\n").trim();
    acumulado = [];
    if (texto === "") return;

    // Demasiado corto para valer una fila propia: se pega al fragmento
    // anterior si existe. Un fragmento de doce palabras nunca responde nada
    // pero compite en el ranking igual.
    const ultimo = fragmentos[fragmentos.length - 1];
    if (texto.length < minimo && ultimo !== undefined && ultimo.tituloSeccion === seccion) {
      fragmentos[fragmentos.length - 1] = {
        ...ultimo,
        texto: `${ultimo.texto}\n\n${texto}`,
        tokensAprox: estimarTokens(`${ultimo.texto}\n\n${texto}`),
      };
      paginaInicio = null;
      return;
    }

    // Si no se pudo pegar a nada y no vale la pena solo, se descarta. Es
    // preferible perder un fragmento de tapa que dejarlo compitiendo en el
    // ranking contra los que sí tienen la respuesta.
    if (descartable(texto, minimo)) {
      paginaInicio = null;
      return;
    }

    fragmentos.push({
      orden: fragmentos.length + 1,
      texto,
      pagina: paginaInicio,
      tituloSeccion: seccion,
      tokensAprox: estimarTokens(texto),
    });
    paginaInicio = null;
  };

  for (const bloque of aBloques(paginas)) {
    if (bloque.esTitulo) {
      // El título cierra lo anterior y pasa a encabezar lo que viene.
      cerrar();
      seccion = bloque.texto;
      continue;
    }

    const largoActual = acumulado.join("\n\n").length;

    // Un bloque que por sí solo excede el tope se parte por oraciones.
    if (bloque.texto.length > maximo) {
      cerrar();
      for (const parte of partirPorOraciones(bloque.texto, maximo)) {
        paginaInicio = bloque.pagina;
        acumulado = [parte];
        cerrar();
      }
      continue;
    }

    if (largoActual > 0 && largoActual + bloque.texto.length > objetivo) {
      cerrar();
    }

    if (paginaInicio === null) paginaInicio = bloque.pagina;
    acumulado.push(bloque.texto);
  }

  cerrar();

  // Se renumera al final: los fragmentos absorbidos por ser demasiado cortos
  // dejarían huecos en la secuencia, y `orden` tiene un índice único junto al
  // documento.
  return fragmentos.map((f, indice) => ({ ...f, orden: indice + 1 }));
}
