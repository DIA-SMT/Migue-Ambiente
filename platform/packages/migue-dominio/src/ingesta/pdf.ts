/**
 * Extracción de texto de PDF.
 *
 * Usa `pdfjs-dist` en lugar de `pdftotext` del sistema, y la decisión salió de
 * medir sobre el corpus real: las dos herramientas extraen prácticamente las
 * mismas palabras (4180 contra 4135 en el PDF del programa SEPARÁ), pero
 * `pdftotext -layout` pega las dos columnas del encabezado en una misma línea,
 * mezclando contenido que no tiene relación. Con Node puro además no hay
 * dependencia del sistema que instalar y mantener.
 *
 * Lo que sí hay que resolver a mano es lo que ninguna de las dos hace:
 * detectar las columnas para no intercalarlas, y unir las palabras cortadas por
 * guion de sílaba.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { limpiar, marcarTitulo } from "./texto.ts";

export interface DocumentoExtraido {
  readonly paginas: readonly string[];
  readonly cantidadPaginas: number;
}

interface Fragmento {
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
  readonly alto: number;
  readonly texto: string;
}

/**
 * Tolerancia vertical para considerar que dos fragmentos están en la misma
 * línea. Dos décimas de la altura de la fuente: dentro de una línea hay
 * variación por subíndices y cambios de tipografía.
 */
const TOLERANCIA_LINEA = 0.2;

/**
 * Ancho mínimo del pasillo entre columnas, como fracción del ancho de página.
 *
 * 4%: por debajo de eso es el espacio entre palabras de un texto justificado,
 * no una separación de columnas.
 */
const PASILLO_MINIMO = 0.04;

/**
 * Cuánto más grande que el cuerpo tiene que ser una línea para ser un título.
 *
 * Medido sobre el corpus: el cuerpo de los tres PDFs del Plan Rector es de
 * 10 pt y los títulos van de 22 a 57 pt, o sea de 2,2x a 5,7x. No hay nada en
 * el medio. Se deja el umbral en 1,5x, bien por debajo del salto real, para
 * que también entren subtítulos más discretos de documentos que todavía no
 * vimos, sin llegar a tomar una negrita del cuerpo.
 */
const TITULO_MINIMO = 1.5;

/**
 * Altura de fuente del cuerpo del documento.
 *
 * Es la altura que concentra más CARACTERES, no la más frecuente entre los
 * fragmentos: un título es un fragmento como cualquier otro, pero el cuerpo
 * aporta el 95% de las letras de la página. Contar caracteres hace que la
 * medida no dependa de cómo el PDF partió el texto en fragmentos.
 */
function alturaDelCuerpo(porPagina: readonly Fragmento[][]): number {
  const porAltura = new Map<number, number>();
  for (const pagina of porPagina) {
    for (const f of pagina) {
      const clave = Math.round(f.alto * 2) / 2;
      porAltura.set(clave, (porAltura.get(clave) ?? 0) + f.texto.length);
    }
  }
  let cuerpo = 10;
  let mayor = 0;
  for (const [altura, caracteres] of porAltura) {
    if (caracteres > mayor) {
      mayor = caracteres;
      cuerpo = altura;
    }
  }
  return cuerpo;
}

/**
 * Detecta el pasillo vertical que separa dos columnas.
 *
 * Recorre el ancho de la página en franjas y busca la franja vacía más ancha
 * dentro del tercio central. Se limita al tercio central a propósito: los
 * márgenes izquierdo y derecho también están vacíos y serían el pasillo más
 * ancho de la página, pero no separan nada.
 *
 * Devuelve la coordenada x del centro del pasillo, o null si la página es de
 * una sola columna.
 */
function detectarPasillo(fragmentos: readonly Fragmento[], anchoPagina: number): number | null {
  if (fragmentos.length < 10) return null;

  const FRANJAS = 100;
  const ocupada = new Array<boolean>(FRANJAS).fill(false);

  for (const f of fragmentos) {
    const desde = Math.max(0, Math.floor((f.x / anchoPagina) * FRANJAS));
    const hasta = Math.min(FRANJAS - 1, Math.ceil(((f.x + f.ancho) / anchoPagina) * FRANJAS));
    for (let i = desde; i <= hasta; i++) ocupada[i] = true;
  }

  // Sólo el tercio central: los márgenes no son pasillos.
  const inicioBusqueda = Math.floor(FRANJAS * 0.33);
  const finBusqueda = Math.ceil(FRANJAS * 0.67);

  let mejorInicio = -1;
  let mejorLargo = 0;
  let actualInicio = -1;

  for (let i = inicioBusqueda; i <= finBusqueda; i++) {
    if (!ocupada[i]) {
      if (actualInicio === -1) actualInicio = i;
      const largo = i - actualInicio + 1;
      if (largo > mejorLargo) {
        mejorLargo = largo;
        mejorInicio = actualInicio;
      }
    } else {
      actualInicio = -1;
    }
  }

  if (mejorLargo / FRANJAS < PASILLO_MINIMO) return null;

  const centro = ((mejorInicio + mejorLargo / 2) / FRANJAS) * anchoPagina;

  // Ambos lados tienen que tener contenido real. Si un lado está casi vacío no
  // hay dos columnas: hay una columna y una imagen o un margen ancho.
  const izquierda = fragmentos.filter((f) => f.x + f.ancho / 2 < centro).length;
  const derecha = fragmentos.length - izquierda;
  const minimo = fragmentos.length * 0.15;

  return izquierda >= minimo && derecha >= minimo ? centro : null;
}

/**
 * Reconstruye líneas a partir de fragmentos sueltos.
 *
 * `pdfjs` no devuelve líneas: devuelve pedazos de texto con su posición. Hay
 * que agruparlos por altura y ordenarlos por posición horizontal.
 *
 * También hay que INSERTAR los espacios que faltan: cuando dos fragmentos
 * contiguos están separados por una distancia mayor que un espacio, pdfjs no
 * emite el espacio. Sin esto aparecen palabras pegadas como
 * «Ambiente ySustentabilidad».
 *
 * Y acá se marcan los títulos, porque es el único lugar donde todavía se sabe
 * de qué tamaño estaba escrita cada línea. Los títulos de estos documentos van
 * partidos en varias líneas —«Antecedentes del» / «Plan Rector»— así que las
 * líneas grandes consecutivas se unen en un solo título.
 */
function reconstruirLineas(fragmentos: readonly Fragmento[], alturaCuerpo: number): string {
  if (fragmentos.length === 0) return "";

  const alturaTipica =
    fragmentos.reduce((suma, f) => suma + f.alto, 0) / fragmentos.length || 10;
  const tolerancia = Math.max(1, alturaTipica * TOLERANCIA_LINEA);

  const lineas: Fragmento[][] = [];
  for (const f of [...fragmentos].sort((a, b) => b.y - a.y)) {
    const ultima = lineas[lineas.length - 1];
    if (ultima && Math.abs((ultima[0]?.y ?? 0) - f.y) <= tolerancia) {
      ultima.push(f);
    } else {
      lineas.push([f]);
    }
  }

  const armadas = lineas
    .map((linea) => {
      const ordenada = linea.sort((a, b) => a.x - b.x);
      let texto = "";
      let finAnterior: number | null = null;

      for (const f of ordenada) {
        if (finAnterior !== null) {
          const hueco = f.x - finAnterior;
          // Un cuarto de la altura de fuente alcanza para distinguir un
          // espacio de dos fragmentos pegados.
          if (hueco > alturaTipica * 0.25) texto += " ";
        }
        texto += f.texto;
        finAnterior = f.x + f.ancho;
      }

      // La altura de la línea es la del fragmento más alto. Los subíndices y
      // superíndices son más CHICOS, así que el máximo no se contamina.
      const alto = Math.max(...ordenada.map((f) => f.alto));
      return { texto: texto.trim(), esTitulo: alto >= alturaCuerpo * TITULO_MINIMO };
    })
    .filter((l) => l.texto !== "");

  // Se unen las líneas de título consecutivas y se separa cada título del
  // cuerpo con un salto doble, que es el límite de párrafo que espera el
  // fragmentador.
  const salida: string[] = [];
  let tituloEnCurso: string[] = [];

  const cerrarTitulo = (): void => {
    if (tituloEnCurso.length === 0) return;
    salida.push(marcarTitulo(tituloEnCurso.join(" ")));
    tituloEnCurso = [];
  };

  for (const linea of armadas) {
    if (linea.esTitulo) {
      tituloEnCurso.push(linea.texto);
    } else {
      cerrarTitulo();
      salida.push(linea.texto);
    }
  }
  cerrarTitulo();

  return salida.join("\n");
}

export async function extraerPdf(datos: Uint8Array): Promise<DocumentoExtraido> {
  const documento = await getDocument({
    data: datos,
    // Sin esto, pdfjs intenta cargar fuentes estándar por red y en la VPS eso
    // significa esperar un tiempo de espera por cada documento.
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;

  try {
    // Primera pasada: se juntan los fragmentos de todas las páginas. Hace falta
    // tenerlos todos antes de armar una sola línea, porque la altura del cuerpo
    // es una propiedad del DOCUMENTO: medirla por página daría un umbral
    // distinto en cada una, y una página que es sólo un título —una portada de
    // capítulo— haría que ese título pase por cuerpo.
    const porPagina: Fragmento[][] = [];
    const anchos: number[] = [];

    for (let numero = 1; numero <= documento.numPages; numero++) {
      const pagina = await documento.getPage(numero);
      const vista = pagina.getViewport({ scale: 1 });
      const contenido = await pagina.getTextContent();

      const fragmentos: Fragmento[] = [];
      for (const item of contenido.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        fragmentos.push({
          x: item.transform[4] as number,
          y: item.transform[5] as number,
          ancho: item.width,
          alto: item.height || 10,
          texto: item.str,
        });
      }

      porPagina.push(fragmentos);
      anchos.push(vista.width);
      pagina.cleanup();
    }

    const alturaCuerpo = alturaDelCuerpo(porPagina);

    // Segunda pasada: ya con el umbral, se arma el texto.
    const paginas = porPagina.map((fragmentos, indice) => {
      const pasillo = detectarPasillo(fragmentos, anchos[indice] ?? 595);

      if (pasillo === null) return reconstruirLineas(fragmentos, alturaCuerpo);

      // Columna izquierda completa y después la derecha, que es el orden en
      // que se lee. Intercalarlas produce fragmentos sin sentido, como
      // «nantes para garantizar un am-• El control de los ruidos mo-».
      const izquierda = fragmentos.filter((f) => f.x + f.ancho / 2 < pasillo);
      const derecha = fragmentos.filter((f) => f.x + f.ancho / 2 >= pasillo);
      return [
        reconstruirLineas(izquierda, alturaCuerpo),
        reconstruirLineas(derecha, alturaCuerpo),
      ]
        .filter((t) => t !== "")
        .join("\n\n");
    });

    return { paginas: limpiar(paginas), cantidadPaginas: documento.numPages };
  } finally {
    // Sin esto, procesar varios documentos seguidos acumula memoria hasta que
    // PM2 reinicia el worker por el límite.
    await documento.destroy();
  }
}
