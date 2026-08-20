/**
 * Validación de los límites del servicio gratuito.
 *
 * El principio que guía todo el módulo: ante la duda, preguntar. Un
 * "dentro del límite" equivocado le promete al vecino un retiro que no va a
 * pasar y manda un camión al lugar equivocado; un "excede" equivocado le
 * niega un servicio al que tiene derecho. Una pregunta más cuesta mucho menos
 * que cualquiera de las dos.
 *
 * Los límites viven en `limites_volumen` y los edita el panel. La spec fija
 * 5 bolsas de escombros, 10 de poda y 1 m³ de voluminosos, pero un borrador
 * los contradice, así que nada de esto está en el código.
 */
import type { CantidadDeclarada, Unidad } from "./cantidad.ts";
import { contienePalabra } from "../texto.ts";

export type Categoria = "escombros" | "poda" | "voluminosos";
export type AccionExceso = "parcial_con_ticket" | "derivar_sin_ticket";

export interface LimiteVolumen {
  readonly categoria: Categoria;
  readonly etiqueta: string;
  readonly limiteValor: number;
  readonly limiteUnidad: Unidad;
  readonly pesoMaxBolsaKg: number | null;
  readonly accionAlExceder: AccionExceso;
  readonly textoExceso: string | null;
  /**
   * Palabras que identifican la categoría en el texto del vecino.
   * Editables desde el panel: el vocabulario real es local y cambia.
   */
  readonly palabras: readonly string[];
  readonly activo: boolean;
}

/** Por qué no se pudo decidir y hay que preguntar. */
export type MotivoPrecision =
  | "sin_cantidad"
  | "cantidad_vaga"
  | "rango_ambiguo"
  | "unidad_no_convertible"
  | "demasiado_cerca_del_limite";

export type ResultadoVolumen =
  | {
      readonly tipo: "dentro";
      readonly limite: LimiteVolumen;
      readonly valorEvaluado: number;
      readonly unidadEvaluada: Unidad;
      readonly convertido: boolean;
    }
  | {
      readonly tipo: "excede";
      readonly limite: LimiteVolumen;
      readonly valorEvaluado: number;
      readonly unidadEvaluada: Unidad;
      readonly convertido: boolean;
      readonly accion: AccionExceso;
      readonly texto: string;
    }
  | {
      readonly tipo: "precisar";
      readonly limite: LimiteVolumen;
      readonly motivo: MotivoPrecision;
    };

/**
 * Equivalencia de una bolsa en metros cúbicos.
 *
 * Es una aproximación operativa, no una medida: una bolsa de consorcio ronda
 * los 40 litros. Se usa sólo para comparar contra un límite expresado en otra
 * unidad, y cuando el resultado queda cerca del límite el módulo prefiere
 * preguntar antes que confiar en el factor.
 */
const M3_POR_BOLSA = 0.04;

/**
 * Margen de duda alrededor del límite, en proporción.
 *
 * Si tras convertir unidades el valor cae dentro de ±25% del límite, la
 * conversión no es lo bastante precisa para decidir y se pregunta. Sin este
 * margen, el factor aproximado de arriba decidiría casos límite con una
 * seguridad que no tiene.
 */
const MARGEN_DUDA = 0.25;

interface Convertido {
  readonly valor: number;
  readonly convertido: boolean;
}

/** Convierte `valor` de `desde` a `hacia`, o null si no hay conversión confiable. */
function convertir(
  valor: number,
  desde: Unidad,
  hacia: Unidad,
  limite: LimiteVolumen,
): Convertido | null {
  if (desde === hacia) return { valor, convertido: false };

  if (desde === "bolsas" && hacia === "m3") {
    return { valor: valor * M3_POR_BOLSA, convertido: true };
  }
  if (desde === "m3" && hacia === "bolsas") {
    return { valor: valor / M3_POR_BOLSA, convertido: true };
  }
  // Kilos a bolsas sólo si la categoría declara cuánto pesa una bolsa. Para
  // escombros la spec dice 15 kg; para poda no hay dato y no se inventa.
  if (desde === "kg" && hacia === "bolsas" && limite.pesoMaxBolsaKg) {
    return { valor: valor / limite.pesoMaxBolsaKg, convertido: true };
  }

  // "unidades" (muebles, sillones, tarimas) no se convierte. No hay factor
  // honesto entre "tres sillas" y un metro cúbico: depende de las sillas.
  return null;
}

/**
 * Decide si el pedido entra en el servicio gratuito.
 */
export function validarVolumen(
  cantidad: CantidadDeclarada,
  limite: LimiteVolumen,
): ResultadoVolumen {
  if (cantidad.vaga !== null) {
    return { tipo: "precisar", limite, motivo: "cantidad_vaga" };
  }
  if (cantidad.valor === null) {
    return { tipo: "precisar", limite, motivo: "sin_cantidad" };
  }

  const unidadOrigen = cantidad.unidad ?? limite.limiteUnidad;

  const base = convertir(cantidad.valor, unidadOrigen, limite.limiteUnidad, limite);
  if (base === null) {
    return { tipo: "precisar", limite, motivo: "unidad_no_convertible" };
  }

  // Un rango que cruza el límite no se puede resolver sin preguntar: "entre 3
  // y 8 bolsas" contra un límite de 5 podría entrar o no.
  if (cantidad.esRango && cantidad.valorMaximo !== null) {
    const techo = convertir(cantidad.valorMaximo, unidadOrigen, limite.limiteUnidad, limite);
    if (techo === null) {
      return { tipo: "precisar", limite, motivo: "unidad_no_convertible" };
    }
    const pisoEntra = base.valor <= limite.limiteValor;
    const techoEntra = techo.valor <= limite.limiteValor;
    if (pisoEntra !== techoEntra) {
      return { tipo: "precisar", limite, motivo: "rango_ambiguo" };
    }
    // Ambos extremos del mismo lado: se evalúa por el techo, que es el
    // compromiso real que asumiría el servicio.
    return decidir(techo, limite);
  }

  return decidir(base, limite);
}

function decidir(medido: Convertido, limite: LimiteVolumen): ResultadoVolumen {
  const { valor, convertido } = medido;

  // La conversión sólo es de fiar lejos del límite. Cerca, se pregunta.
  if (convertido) {
    const distancia = Math.abs(valor - limite.limiteValor) / limite.limiteValor;
    if (distancia <= MARGEN_DUDA) {
      return { tipo: "precisar", limite, motivo: "demasiado_cerca_del_limite" };
    }
  }

  if (valor <= limite.limiteValor) {
    return {
      tipo: "dentro",
      limite,
      valorEvaluado: redondear(valor),
      unidadEvaluada: limite.limiteUnidad,
      convertido,
    };
  }

  return {
    tipo: "excede",
    limite,
    valorEvaluado: redondear(valor),
    unidadEvaluada: limite.limiteUnidad,
    convertido,
    accion: limite.accionAlExceder,
    texto: limite.textoExceso ?? textoExcesoPorDefecto(limite),
  };
}

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100;
}

function textoExcesoPorDefecto(limite: LimiteVolumen): string {
  const unidad = limite.limiteUnidad === "m3" ? "m³" : limite.limiteUnidad;
  return (
    `Tu pedido excede el límite del servicio gratuito ` +
    `(${limite.limiteValor} ${unidad} para ${limite.etiqueta.toLowerCase()}). ` +
    `Podés acercar el excedente a un Punto Verde o contratar un contenedor privado.`
  );
}

/**
 * Pregunta concreta para resolver una falta de precisión.
 *
 * Devuelve UNA pregunta con opciones cerradas, no un cuestionario. La crítica
 * central del QA al bot anterior era que preguntaba de más antes de dar
 * información; acá cada pregunta tiene que ganarse el lugar, y esta se lo gana
 * porque de la respuesta depende si el servicio aplica.
 */
export function preguntaParaPrecisar(resultado: {
  limite: LimiteVolumen;
  motivo: MotivoPrecision;
}): string {
  const { limite, motivo } = resultado;
  const unidad = limite.limiteUnidad === "m3" ? "m³" : limite.limiteUnidad;
  const tope = `${limite.limiteValor} ${unidad}`;

  if (motivo === "unidad_no_convertible") {
    return (
      `Para saber si entra en el servicio gratuito necesito una referencia de volumen. ` +
      `¿El total ocupa menos de ${tope}, más o menos eso, o bastante más?`
    );
  }
  if (motivo === "rango_ambiguo" || motivo === "demasiado_cerca_del_limite") {
    return (
      `Me quedó la duda de si entra en el límite del servicio gratuito (${tope}). ` +
      `¿Me confirmás la cantidad exacta?`
    );
  }
  return `¿Qué cantidad aproximada es? Contame en ${limite.limiteUnidad === "m3" ? "metros cúbicos" : limite.limiteUnidad}, el límite del servicio gratuito es ${tope}.`;
}

/** Busca el límite de una categoría dentro de los cargados en la base. */
export function limiteDe(
  categoria: Categoria,
  limites: readonly LimiteVolumen[],
): LimiteVolumen | null {
  return limites.find((l) => l.categoria === categoria && l.activo) ?? null;
}

/**
 * Deduce la categoría de residuo a partir del texto del vecino.
 *
 * Cuenta coincidencias por categoría y devuelve la que más tenga, en vez de
 * quedarse con la primera. Importa para mensajes mixtos: «saqué los muebles y
 * quedaron unos ladrillos y cascotes de la obra» tiene una palabra de
 * voluminosos y tres de escombros — gana escombros, que es lo correcto para
 * elegir el límite.
 *
 * Devuelve null si hay empate o si no reconoce nada: en ese caso el flujo
 * pregunta, que es mejor que elegir un límite al azar.
 */
export function detectarCategoria(
  texto: string,
  limites: readonly LimiteVolumen[],
): Categoria | null {
  const conteos = limites
    .filter((l) => l.activo)
    .map((l) => ({
      categoria: l.categoria,
      coincidencias: l.palabras.filter((p) => contienePalabra(texto, p)).length,
    }))
    .filter((c) => c.coincidencias > 0)
    .sort((a, b) => b.coincidencias - a.coincidencias);

  if (conteos.length === 0) return null;
  // Empate: no adivinar, preguntar.
  if (conteos.length > 1 && conteos[0]!.coincidencias === conteos[1]!.coincidencias) return null;
  return conteos[0]!.categoria;
}
