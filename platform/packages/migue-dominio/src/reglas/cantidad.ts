/**
 * Interpretación de la cantidad que declara el vecino en texto libre.
 *
 * De acá sale si el pedido entra en el servicio gratuito, así que una lectura
 * errónea le promete a un vecino algo que no va a pasar. El módulo prefiere
 * declararse incapaz (devolver `vaga` o null) antes que adivinar: la duda la
 * resuelve una pregunta, un número inventado la esconde.
 *
 * El bot anterior no capturaba cantidad en absoluto — las columnas
 * `waste_type` y `quantity` están vacías en todas las filas heredadas — y por
 * eso aceptó el pedido del árbol caído.
 */
import { normalizar } from "../texto.ts";

export type Unidad = "bolsas" | "m3" | "kg" | "unidades";

/** Vaguedad explícita del vecino. Los borradores mencionan "poco–medio–mucho". */
export type TerminoVago = "poco" | "medio" | "mucho";

export interface CantidadDeclarada {
  /** Valor interpretado. En un rango, el extremo inferior. */
  readonly valor: number | null;
  /** Extremo superior si el vecino dio un rango ("entre 5 y 10"). */
  readonly valorMaximo: number | null;
  readonly unidad: Unidad | null;
  readonly vaga: TerminoVago | null;
  readonly esRango: boolean;
  readonly textoOriginal: string;
}

const SIN_DATO: Omit<CantidadDeclarada, "textoOriginal"> = {
  valor: null,
  valorMaximo: null,
  unidad: null,
  vaga: null,
  esRango: false,
};

// ---------------------------------------------------------------------------
// Números escritos con palabras. Se corta en 30 a propósito: por encima de eso
// cualquier categoría ya excede el límite, así que la precisión no cambia la
// decisión y no vale la pena mantener la tabla.
// ---------------------------------------------------------------------------
const NUMEROS_PALABRA = new Map<string, number>([
  ["un", 1], ["una", 1], ["uno", 1],
  ["dos", 2], ["tres", 3], ["cuatro", 4], ["cinco", 5],
  ["seis", 6], ["siete", 7], ["ocho", 8], ["nueve", 9], ["diez", 10],
  ["once", 11], ["doce", 12], ["trece", 13], ["catorce", 14], ["quince", 15],
  ["dieciseis", 16], ["diecisiete", 17], ["dieciocho", 18], ["diecinueve", 19],
  ["veinte", 20], ["veintiuno", 21], ["veinticinco", 25], ["treinta", 30],
  ["medio", 0.5],
]);

// Sinónimos por unidad. Se comparan sobre tokens normalizados.
const UNIDADES: ReadonlyArray<readonly [Unidad, readonly string[]]> = [
  ["m3", ["m3", "metro", "metros", "cubico", "cubicos", "metro3"]],
  ["bolsas", ["bolsa", "bolsas", "bolson", "bolsones", "changuito", "changuitos"]],
  ["kg", ["kg", "kilo", "kilos", "kilogramo", "kilogramos"]],
  [
    "unidades",
    [
      "mueble", "muebles", "sillon", "sillones", "silla", "sillas",
      "colchon", "colchones", "heladera", "heladeras", "ropero", "roperos",
      "mesa", "mesas", "electrodomestico", "electrodomesticos",
      "unidad", "unidades", "tarima", "tarimas",
    ],
  ],
];

const TERMINOS_VAGOS: ReadonlyArray<readonly [TerminoVago, readonly string[]]> = [
  ["poco", ["poco", "poquito", "poca", "poquita", "algo", "nada que ver", "minimo"]],
  ["medio", ["medio", "media", "regular", "normal", "mas o menos"]],
  ["mucho", ["mucho", "mucha", "muchisimo", "bastante", "monton", "monton", "grande", "enorme", "un camion", "camionada"]],
];

/** Palabras que pueden separar el número de la unidad sin romper la relación. */
const RELLENO = new Set(["de", "aprox", "aproximadamente", "como", "unos", "unas", "y", "a", "mas", "menos", "cerca"]);

function aNumero(token: string): number | null {
  if (/^\d+([.,]\d+)?$/.test(token)) {
    const n = Number(token.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return NUMEROS_PALABRA.get(token) ?? null;
}

function unidadDeToken(token: string): Unidad | null {
  for (const [unidad, sinonimos] of UNIDADES) {
    if (sinonimos.includes(token)) return unidad;
  }
  return null;
}

/**
 * Extrae cantidad y unidad de un texto libre.
 *
 * Estrategia: tokenizar, ubicar la palabra de unidad y buscar el número hacia
 * atrás hasta 3 tokens, saltando relleno. La adyacencia es lo que evita el
 * falso positivo clásico: en "tengo un problema con las bolsas", "un" no debe
 * leerse como la cantidad de bolsas.
 */
export function interpretarCantidad(texto: string): CantidadDeclarada {
  const normalizado = normalizar(texto);
  if (normalizado === "") return { ...SIN_DATO, textoOriginal: texto };

  const tokens = normalizado.split(" ");

  // "metro cubico" son dos tokens que valen una sola unidad; unificarlos evita
  // que "metro" solo se confunda con una medida lineal de una dirección.
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if ((a === "metro" || a === "metros") && (b === "cubico" || b === "cubicos")) {
      tokens.splice(i, 2, "m3");
    }
  }

  let unidad: Unidad | null = null;
  let indiceUnidad = -1;
  for (let i = 0; i < tokens.length; i++) {
    const u = unidadDeToken(tokens[i]!);
    if (u) {
      unidad = u;
      indiceUnidad = i;
      break;
    }
  }

  const numeros: number[] = [];
  if (indiceUnidad >= 0) {
    // Hacia atrás desde la unidad. La adyacencia la impone el `break`: al
    // primer token que no sea número ni relleno, se corta. Eso es lo que evita
    // leer "tengo un problema con las bolsas" como 1 bolsa — "las" corta.
    for (let i = indiceUnidad - 1; i >= 0; i--) {
      const token = tokens[i]!;
      const n = aNumero(token);
      if (n !== null) {
        numeros.unshift(n);
        continue; // "entre 5 y 10 bolsas" trae dos números
      }
      if (RELLENO.has(token) || token === "entre") continue;
      break;
    }
  }

  // La vaguedad se detecta ANTES de recurrir a números sueltos, y esa
  // precedencia importa: en "es mucho, un camion" el "un" de "un camion" se
  // leería como cantidad 1 y taparía el "mucho". Un vecino que dice tener un
  // camión de escombros no puede resolverse como una unidad.
  const vagaTexto = detectarVaguedad(normalizado);

  // Sin unidad, un número suelto es evidencia débil ("son 5"). Sólo se usa si
  // el vecino no expresó vaguedad, que es una señal más fuerte.
  if (indiceUnidad < 0 && vagaTexto === null) {
    for (const token of tokens) {
      const n = aNumero(token);
      // "medio" solo, sin unidad, es vaguedad y no el número 0.5
      if (n !== null && token !== "medio") {
        numeros.push(n);
        break;
      }
    }
  }

  if (numeros.length === 0) {
    return { ...SIN_DATO, unidad, vaga: vagaTexto, textoOriginal: texto };
  }

  // Con unidad y número concreto, el número gana sobre el adjetivo:
  // "muchas, unas 12 bolsas" son 12, no "mucho".
  const vaga = unidad !== null ? null : vagaTexto;

  const ordenados = [...numeros].sort((a, b) => a - b);
  const esRango = ordenados.length > 1;

  return {
    valor: ordenados[0]!,
    valorMaximo: esRango ? ordenados[ordenados.length - 1]! : null,
    unidad,
    vaga: esRango ? null : vaga,
    esRango,
    textoOriginal: texto,
  };
}

function detectarVaguedad(normalizado: string): TerminoVago | null {
  for (const [termino, sinonimos] of TERMINOS_VAGOS) {
    for (const s of sinonimos) {
      const patron = new RegExp(`(?<![\\p{L}\\p{N}])${s}(s|es)?(?![\\p{L}\\p{N}])`, "u");
      if (patron.test(normalizado)) return termino;
    }
  }
  return null;
}

/** ¿Alcanza para decidir si entra en el límite, o hay que preguntar? */
export function esUtilizable(cantidad: CantidadDeclarada): boolean {
  return cantidad.valor !== null && cantidad.unidad !== null;
}

/**
 * Convierte una palabra-número en número, o null.
 *
 * Se exporta porque el flujo B necesita la misma tabla para leer «hace tres
 * días». Duplicarla sería garantizar que las dos versiones se desincronicen.
 */
export function palabraANumero(token: string): number | null {
  return aNumero(normalizar(token));
}
