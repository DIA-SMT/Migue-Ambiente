/**
 * Interpretación de direcciones escritas por el vecino.
 *
 * La spec descarta la ubicación por GPS a propósito —«para evitar errores de
 * precisión, el usuario debe escribirla»— así que esto tiene que aguantar cómo
 * escribe la gente de verdad: «Lavalle al 500», «Muñecas 200 entre Salta y
 * Corrientes», «25 de Mayo 300».
 *
 * No valida contra un padrón de calles: no tenemos ese dato. Sólo verifica que
 * la dirección tenga la forma mínima que una cuadrilla necesita para salir —
 * calle y altura— y que no sea una frase suelta.
 */
import { normalizar } from "../texto.ts";

export interface DireccionInterpretada {
  readonly calle: string | null;
  /** Cadena y no número: existen «1200 bis», «s/n», «450 A». */
  readonly numero: string | null;
  readonly entreCalles: string | null;
  readonly referencia: string | null;
  /** Tiene lo mínimo para que una cuadrilla la encuentre. */
  readonly completa: boolean;
  readonly textoOriginal: string;
}

const SIN_DATO: Omit<DireccionInterpretada, "textoOriginal"> = {
  calle: null,
  numero: null,
  entreCalles: null,
  referencia: null,
  completa: false,
};

/** Palabras que anteceden a la altura sin ser parte del nombre de la calle. */
const ANTES_DEL_NUMERO = new Set(["al", "nro", "nro.", "n", "no", "numero", "altura", "esq", "esquina"]);

/** Prefijos de vía que no aportan al nombre pero conviene conservar. */
const PREFIJOS_VIA = new Set(["av", "avda", "avenida", "calle", "pasaje", "psje", "bv", "boulevard"]);

/** Marcas de que lo que sigue es una referencia y no parte de la dirección. */
const MARCAS_REFERENCIA = ["entre", "e/", "casi", "frente a", "altura de", "barrio", "b°", "bº"];

function esNumeroDeCalle(token: string): boolean {
  // Hasta 5 dígitos, con sufijo opcional: 500, 1200, 450A, 12bis
  return /^\d{1,5}(\s?(bis|[a-z]))?$/i.test(token);
}

/**
 * Separa la parte «entre X y Y» del resto.
 *
 * Se hace primero porque los nombres de las calles cruzadas pueden contener
 * números («entre 24 de Septiembre y Muñecas») y confundirían la búsqueda de
 * la altura.
 */
function separarEntreCalles(texto: string): { principal: string; entre: string | null } {
  // Se busca sobre el texto ORIGINAL, no el normalizado: normalizar convierte
  // "e/" en "e " y destruye la marca. "entre" no lleva tilde, así que buscar
  // en el original no pierde nada y evita hacer aritmética de índices entre
  // dos cadenas de largo distinto.
  const patron = /(?:^|[\s,;])(?:entre|e\/)\s*/i;
  const m = patron.exec(texto);
  if (m?.index === undefined) return { principal: texto, entre: null };

  return {
    principal: texto.slice(0, m.index).trim().replace(/[,;]$/, ""),
    entre: texto.slice(m.index + m[0].length).trim() || null,
  };
}

/** Separa una referencia final («, barrio X», «casi Y», «frente a la plaza»). */
function separarReferencia(texto: string): { principal: string; referencia: string | null } {
  for (const marca of MARCAS_REFERENCIA) {
    if (marca === "entre" || marca === "e/") continue;
    const idx = normalizar(texto).indexOf(normalizar(marca));
    if (idx > 0) {
      const idxReal = texto.toLowerCase().indexOf(marca.toLowerCase());
      if (idxReal > 0) {
        return {
          principal: texto.slice(0, idxReal).trim().replace(/[,;]$/, ""),
          referencia: texto.slice(idxReal).trim() || null,
        };
      }
    }
  }
  return { principal: texto, referencia: null };
}

/**
 * Frases con las que el vecino dice que NO sabe la dirección.
 *
 * Sin este filtro, «no se la direccion» se tomaba como nombre de calle y el
 * bot repreguntaba «Me falta la altura de no se la direccion», que además de
 * absurdo hace que el vecino piense que el bot no lo entendió.
 */
const NO_SABE = ["no se", "no lo se", "no tengo", "ni idea", "no me acuerdo", "desconozco"];

export function interpretarDireccion(texto: string): DireccionInterpretada {
  if (!texto || normalizar(texto) === "") {
    return { ...SIN_DATO, textoOriginal: texto };
  }

  const norm = normalizar(texto);
  if (NO_SABE.some((f) => norm.includes(f))) {
    return { ...SIN_DATO, textoOriginal: texto };
  }

  const { principal: sinEntre, entre } = separarEntreCalles(texto);
  const { principal, referencia } = separarReferencia(sinEntre);

  // «sin número» y «s/n» son respuestas válidas: hay terrenos sin altura.
  const normPrincipal = normalizar(principal);
  const sinNumeroExplicito = /(^|\s)(s\s?n|sin numero|sin altura)(\s|$)/.test(normPrincipal);

  const tokens = principal.split(/[\s,]+/).filter(Boolean);

  // La altura es el ÚLTIMO número de la parte principal. Esto es lo que hace
  // que «25 de Mayo 300» se lea como calle «25 de Mayo» y altura 300, en vez
  // de tomar el 25 como altura.
  let indiceNumero = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (esNumeroDeCalle(tokens[i]!)) {
      indiceNumero = i;
      break;
    }
  }

  let numero: string | null = null;
  let tokensCalle: string[] = tokens;

  if (indiceNumero >= 0) {
    numero = tokens[indiceNumero]!;
    // Un sufijo suelto tipo «bis» o «A» que quedó como token aparte
    const siguiente = tokens[indiceNumero + 1];
    if (siguiente && /^(bis|[a-z])$/i.test(siguiente)) {
      numero = `${numero} ${siguiente}`;
    }
    tokensCalle = tokens.slice(0, indiceNumero);
  } else if (sinNumeroExplicito) {
    numero = "s/n";
    tokensCalle = tokens.filter((t) => !/^(s\/?n|sin|numero|altura)$/i.test(t));
  }

  // Sacar los conectores que anteceden a la altura sin ser parte del nombre.
  while (tokensCalle.length > 0) {
    const ultimo = normalizar(tokensCalle[tokensCalle.length - 1]!);
    if (ANTES_DEL_NUMERO.has(ultimo)) tokensCalle.pop();
    else break;
  }

  const calle = tokensCalle.join(" ").replace(/[,;.]$/, "").trim() || null;

  // Una calle tiene que tener al menos una palabra que no sea sólo un prefijo
  // de vía: «Av. 500» no es una dirección, «Av. Sarmiento 500» sí.
  const calleUtil =
    calle !== null &&
    calle
      .split(/\s+/)
      .some((p) => !PREFIJOS_VIA.has(normalizar(p)) && normalizar(p).length >= 3);

  return {
    calle: calleUtil ? calle : null,
    numero,
    entreCalles: entre,
    referencia,
    completa: calleUtil && numero !== null,
    textoOriginal: texto,
  };
}

/**
 * Qué falta para poder despachar una cuadrilla.
 *
 * Devuelve UNA pregunta, no una lista de faltantes: la crítica del QA al bot
 * anterior era que preguntaba de más. Si falta todo, se pide todo junto en una
 * sola frase.
 */
export function preguntaPorDireccion(d: DireccionInterpretada): string | null {
  if (d.completa) return null;
  if (d.calle === null && d.numero === null) {
    return "Necesito la dirección exacta: calle y altura. Por ejemplo: Lavalle al 500.";
  }
  if (d.calle !== null && d.numero === null) {
    return `Me falta la altura de ${d.calle}. ¿A qué número queda?`;
  }
  return "Me falta el nombre de la calle. ¿Cuál es?";
}

/** Dirección lista para guardar en el ticket, en una línea. */
export function formatearDireccion(d: DireccionInterpretada): string {
  if (!d.completa) return d.textoOriginal.trim();
  const partes = [`${d.calle} ${d.numero}`];
  if (d.entreCalles) partes.push(`entre ${d.entreCalles}`);
  if (d.referencia) partes.push(d.referencia);
  return partes.join(", ");
}
