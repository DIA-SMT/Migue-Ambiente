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
 * Sustantivos que, cuando siguen a un número, lo convierten en una cantidad y
 * no en una altura.
 *
 * El rol de un número lo define lo que va DESPUÉS, no sólo lo que va antes.
 * Sin esta lista, «Escuela Normal, 30 alumnos» se leía como la dirección
 * «Escuela Normal 30» y registraba la solicitud sin pedir el domicilio.
 */
const SUSTANTIVOS_CONTADOS = new Set([
  "alumnos", "alumno", "chicos", "chicas", "estudiantes", "ninos", "ninas",
  "personas", "bolsas", "bolsa", "bolsones", "dias", "dia", "semanas", "semana",
  "meses", "mes", "anos", "kg", "kilos", "kilogramos", "metros", "metro", "m3",
  "cuadras", "cuadra", "horas", "hora", "unidades", "tarimas", "sillas",
]);

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

/**
 * Marcas de que la dirección ya terminó y lo que sigue es otra cosa.
 *
 * Hacen falta porque en el flujo B el vecino escribe todo junto: «Lavalle 500,
 * hace 3 días que no pasan». Sin cortar acá, la búsqueda de la altura se
 * quedaba con el 3 de los días y la dirección terminaba siendo
 * «Lavalle 500 hace 3».
 */
/** Cortan la dirección y lo que sigue SE CONSERVA como referencia útil. */
const FIN_CON_REFERENCIA = [",", ";", "("];

/**
 * Cortan la dirección y lo que sigue SE DESCARTA.
 *
 * Son cláusulas temporales o causales del reclamo, no datos del domicilio.
 * Conservarlas como «referencia» hacía que el ticket guardara
 * «Lavalle 500, hace 3 dias que no pasan» en el campo dirección.
 */
const FIN_A_DESCARTAR = [" hace ", " desde ", " porque ", " y no ", " que no ", " ya que "];

/**
 * Palabras que nunca aparecen en el nombre de una calle.
 *
 * Sin este filtro, «no pasa el camion hace 3 dias» se leía como calle
 * «no pasa el camion hace» y altura 3 — y generaba un ticket con una dirección
 * a la que no se puede mandar una cuadrilla.
 */
const NO_ES_CALLE = new Set([
  // Vocabulario del reclamo
  "no", "pasa", "pasan", "paso", "pasaron", "tengo", "tenemos", "necesito",
  "quiero", "hay", "esta", "estan", "camion", "basura", "residuos", "bolsa",
  "bolsas", "recolector", "reclamo", "queja", "servicio", "vino", "vienen",
  // Etiquetas de datos de contacto. Sin estas, el segmento «tel 381 4440012»
  // de un mensaje con varios datos se leía como calle «tel», altura 381 — y
  // ganaba sobre la dirección real, que venía en un segmento posterior.
  "tel", "telefono", "tel.", "cel", "celular", "cel.", "whatsapp", "wsp",
  "contacto", "mail", "email", "dni", "nombre", "soy", "llamar", "alumnos",
  // Conjunciones y adverbios con los que arranca una queja. Sin esto,
  // «hace 3 dias que no pasan» se leía como la calle «hace 3 dias» y el bot
  // contestaba «Me falta la altura de hace 3 dias. ¿A qué número queda?».
  "hace", "desde", "que", "porque", "cuando", "vecino", "vecina",
  // Saludos y muletillas. Mismo síntoma con «hola»: no hay forma de distinguir
  // «Lavalle» de «hola» sin un padrón de calles, que no tenemos; esta lista
  // cubre lo que la gente escribe de verdad.
  "hola", "buenas", "buenos", "buen", "che", "chau", "gracias", "ok", "dale",
  "listo", "bueno", "perdon", "disculpa", "consulta",
]);

/**
 * Corta el texto donde la dirección deja de ser dirección.
 *
 * La coma sólo corta si lo que quedó ANTES ya tiene un número. Así
 * «Lavalle 500, hace 3 días» corta bien, y «Lavalle, 500» —donde la coma
 * separa la calle de la altura— no se parte por la mitad.
 */
function separarReferencia(texto: string): { principal: string; referencia: string | null } {
  let corte = -1;
  let conservar = false;

  const evaluar = (marcas: readonly string[], seConserva: boolean) => {
    for (const marca of marcas) {
      const idx = texto.toLowerCase().indexOf(marca);
      if (idx <= 0) continue;
      // Sin altura todavía, cortar destruiría la dirección: «Lavalle, 500».
      if (!/\d/.test(texto.slice(0, idx))) continue;
      if (corte === -1 || idx < corte) {
        corte = idx;
        conservar = seConserva;
      }
    }
  };

  evaluar(FIN_CON_REFERENCIA, true);
  evaluar(FIN_A_DESCARTAR, false);

  if (corte === -1) return { principal: texto, referencia: null };

  const cola = texto.slice(corte).replace(/^[,;\s]+/, "").trim();

  // Aunque el corte lo haya hecho una coma, la cola se descarta si ES una
  // cláusula del reclamo: en «Lavalle 500, hace 3 días que no pasan» la coma
  // aparece antes del «hace», así que sin este chequeo la cola se conservaba
  // como referencia y terminaba dentro del campo dirección del ticket.
  const colaEsClausula = FIN_A_DESCARTAR.some((m) => normalizar(cola).startsWith(m.trim()));

  return {
    principal: texto.slice(0, corte).trim().replace(/[,;]$/, ""),
    referencia: conservar && !colaEsClausula && cola !== "" ? cola : null,
  };
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
    if (!esNumeroDeCalle(tokens[i]!)) continue;
    // Un número seguido de un sustantivo contable es una cantidad, no una
    // altura: se descarta y se sigue buscando hacia atrás.
    const siguiente = tokens[i + 1];
    if (siguiente !== undefined && SUSTANTIVOS_CONTADOS.has(normalizar(siguiente))) continue;
    indiceNumero = i;
    break;
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

  // Tres condiciones para aceptar algo como nombre de calle:
  //
  // 1. Al menos una palabra que no sea sólo prefijo de vía: «Av. 500» no es
  //    una dirección, «Av. Sarmiento 500» sí.
  // 2. Ninguna palabra del vocabulario del reclamo: sin esto, «no pasa el
  //    camion hace 3 dias» generaba un ticket con calle «no pasa el camion
  //    hace» y altura 3, y una cuadrilla no puede salir a eso.
  // 3. Un techo de palabras. Los nombres largos existen («Av. Presidente
  //    Roque Sáenz Peña» son cinco), pero una frase entera nunca es una calle.
  const palabrasCalle = calle === null ? [] : calle.split(/\s+/).map((p) => normalizar(p));
  const calleUtil =
    calle !== null &&
    palabrasCalle.length <= 5 &&
    palabrasCalle.some((p) => !PREFIJOS_VIA.has(p) && p.length >= 3) &&
    !palabrasCalle.some((p) => NO_ES_CALLE.has(p));

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

/**
 * Busca una dirección DENTRO de un texto que trae varios datos juntos.
 *
 * `interpretarDireccion` asume que todo el texto es la dirección, y sirve
 * cuando el bot preguntó justamente eso. Pero en los flujos de programas el
 * vecino manda todo en un mensaje —«Escuela Normal, Muñecas 200, responsable
 * Ramiro, 30 alumnos, tel 3814440055»— y ahí el texto completo no es una
 * dirección: hay tres números y sólo uno es la altura.
 *
 * Estrategia: primero se prueba el texto entero, y si no da, se prueba
 * segmento por segmento. El primer segmento que resuelve en una dirección
 * completa gana.
 *
 * Sin esto, el bot le pedía la dirección que el vecino ya había escrito, que
 * es exactamente la queja del documento de QA.
 */
export function buscarDireccion(texto: string): DireccionInterpretada {
  const completo = interpretarDireccion(texto);
  if (completo.completa) return completo;

  const segmentos = texto
    .split(/[,;·\n|]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);

  for (const segmento of segmentos) {
    const d = interpretarDireccion(segmento);
    if (d.completa) return d;
  }

  // Ninguno resolvió: se devuelve el intento sobre el texto completo, que es
  // el que produce el mensaje de repregunta más útil.
  return completo;
}
