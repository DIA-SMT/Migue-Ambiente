/**
 * Qué es cada regla, qué valores admite, y qué pasa si se pone mal.
 *
 * Es el archivo más importante de la pantalla Reglas, y no porque sea el más
 * largo: es el único lugar donde está escrito qué significa cada una de las 19
 * claves de `configuracion`. La tabla guarda `jsonb` sin ninguna restricción por
 * clave, así que sin esto la pantalla sería un editor de JSON crudo — y un valor
 * mal puesto acá no da un error de base, da un error EN LA CARA DEL VECINO.
 *
 * El caso concreto, verificado en el código: `calcularVencimiento()` (sla.ts) es
 * un `switch` sobre tres modos SIN rama por defecto. Con un `sla_modo` que no sea
 * exactamente uno de los tres devuelve `undefined`, y el paso siguiente hace
 * `formatearFechaLocal(undefined)` → `undefined.getTime()` → TypeError. Ocurre en
 * el ÚLTIMO paso del flujo de retiro, después de que el vecino ya mandó la foto y
 * la dirección. Variante silenciosa: `sla_horas_habiles` con un valor no numérico
 * da `NaN`, y Migue manda «un plazo de hasta NaN días hábiles».
 *
 * Por eso la validación vive acá y no en un CHECK de la base. Un CHECK devuelve
 * un 23514 que nadie entiende, y la pantalla igual tendría que validar antes para
 * poder explicar en castellano. La base como red de contención se puede agregar
 * después; el mensaje útil sólo puede estar de este lado.
 */

export type TipoValor = "booleano" | "entero" | "decimal" | "texto" | "opcion" | "lista";

export interface DefinicionClave {
  readonly clave: string;
  /** El nombre en palabras del área, no el de la columna. */
  readonly rotulo: string;
  /** Qué cambia si se toca. En términos de lo que recibe un vecino. */
  readonly queHace: string;
  readonly tipo: TipoValor;
  readonly opciones?: readonly { valor: string; rotulo: string }[];
  readonly minimo?: number;
  readonly maximo?: number;
  readonly unidad?: string;
  /**
   * Qué se rompe si se pone un valor inválido. Se muestra al editar, no después
   * de guardar: la idea es que nadie lo descubra por un vecino.
   */
  readonly siSeRompe?: string;
  /**
   * Si el código NO lee esta clave. El texto explica qué pasa en realidad.
   *
   * No se ocultan. Un control escondido vuelve a aparecer la próxima vez que
   * alguien lea la tabla, y entonces nadie sabe por qué no funcionaba. Mostrarlo
   * marcado es lo que evita que un operador cambie el valor, vea que el bot
   * sigue igual, y deje de creerle a toda la pantalla.
   */
  readonly huerfana?: string;
  /** `alta` = cambia lo que el vecino lee o recibe. Se pide confirmación. */
  readonly consecuencia?: "alta";
}

export interface GrupoDeReglas {
  readonly rotulo: string;
  readonly explicacion: string;
  readonly claves: readonly DefinicionClave[];
}

const MODOS_SLA = [
  { valor: "dias_habiles", rotulo: "Días hábiles" },
  { valor: "horas_corridas", rotulo: "Horas corridas (incluye fines de semana)" },
  { valor: "horas_habiles", rotulo: "Horas hábiles (sólo dentro de la jornada)" },
] as const;

export const GRUPOS_DE_REGLAS: readonly GrupoDeReglas[] = [
  {
    rotulo: "A dónde se deriva lo que no es de Ambiente",
    explicacion:
      "Este bot es de la Secretaría de Ambiente. Cuando un vecino insiste con algo que no es " +
      "nuestro, en lugar de repetirle el menú se lo manda a Migue, el asistente general del " +
      "municipio. Es el grupo más importante de esta pantalla: sin el enlace cargado, la " +
      "derivación no funciona y el bot vuelve al menú.",
    claves: [
      {
        clave: "enlace_migue",
        rotulo: "Enlace o número de Migue",
        queHace:
          "El número de WhatsApp de Migue. Escribilo como lo tenés en la agenda —por ejemplo " +
          "3812067777— y el panel arma el enlace solo. También podés pegar un enlace completo si " +
          "preferís.",
        tipo: "texto",
        siSeRompe:
          "Mientras esté vacío el bot NO deriva: vuelve a mostrar el menú. Es a propósito — " +
          "decirle «escribile a Migue» sin decirle a dónde lo deja peor que antes.",
        consecuencia: "alta",
      },
      {
        clave: "derivar_tras_intentos",
        rotulo: "Cuántas veces mostrar el menú antes de derivar",
        queHace:
          "Con 1, el vecino ve el menú una vez y si insiste con algo que no encaja se lo deriva. " +
          "Con 0 se deriva en el primer mensaje que no se entienda.",
        tipo: "entero",
        minimo: 0,
        maximo: 3,
        unidad: "veces",
        siSeRompe:
          "En 0, cada error de clasificación se convierte en una derivación injusta: un vecino " +
          "que preguntó algo que SÍ era nuestro se va a otro número porque el bot lo leyó mal. " +
          "El menú actúa de red.",
        consecuencia: "alta",
      },
    ],
  },
  {
    rotulo: "El plazo que Migue promete",
    explicacion:
      "Con esto se calcula la fecha que el bot le dice al vecino cuando toma un pedido. Es lo " +
      "que el municipio se está comprometiendo a cumplir, así que es el grupo de mayor " +
      "consecuencia de toda la pantalla.",
    claves: [
      {
        clave: "sla_modo",
        rotulo: "Cómo se cuenta el plazo",
        queHace:
          "Define si las horas del plazo se cuentan corridas, sólo en días hábiles, o sólo " +
          "dentro del horario de trabajo.",
        tipo: "opcion",
        opciones: MODOS_SLA,
        siSeRompe:
          "Un valor distinto de estos tres hace que el bot se caiga en el último paso del " +
          "pedido, después de que el vecino ya mandó la foto y la dirección. No hay reintento: " +
          "el pedido se pierde.",
        consecuencia: "alta",
      },
      {
        clave: "sla_horas_habiles",
        rotulo: "Duración del plazo",
        queHace: "Cuántas horas o días hábiles tiene el área para resolver un pedido.",
        tipo: "entero",
        minimo: 1,
        maximo: 720,
        unidad: "horas",
        siSeRompe:
          "Un valor que no sea un número hace que Migue le diga al vecino «un plazo de hasta " +
          "NaN días hábiles», con la fecha de vencimiento puesta en este mismo momento.",
        consecuencia: "alta",
      },
      {
        clave: "sla_jornada_desde",
        rotulo: "La jornada empieza",
        queHace: "Desde qué hora se cuentan las horas hábiles.",
        tipo: "entero",
        minimo: 0,
        maximo: 23,
        unidad: "h",
      },
      {
        clave: "sla_jornada_hasta",
        rotulo: "La jornada termina",
        queHace: "Hasta qué hora se cuentan las horas hábiles.",
        tipo: "entero",
        minimo: 1,
        maximo: 24,
        unidad: "h",
      },
      {
        clave: "sla_sabado_habil",
        rotulo: "El sábado cuenta como hábil",
        queHace: "Si los sábados se descuentan del plazo o no.",
        tipo: "booleano",
      },
      {
        clave: "feriados",
        rotulo: "Feriados",
        queHace:
          "Los días que no cuentan para el plazo. Se escriben uno por línea, en formato " +
          "2026-12-25.",
        tipo: "lista",
        siSeRompe:
          "Si esto no es una lista de fechas, el bot se cae al calcular cualquier plazo. " +
          "Vacío está bien: significa que no hay feriados cargados.",
        consecuencia: "alta",
      },
    ],
  },
  {
    rotulo: "Cuándo Migue se anima a responder",
    explicacion:
      "Dos umbrales de confianza. Bajarlos hace que el bot responda más seguido y se equivoque " +
      "más; subirlos hace que diga «no tengo esa información» más seguido. No hay valor " +
      "correcto: depende de qué error es más caro para el área.",
    claves: [
      {
        clave: "umbral_confianza",
        rotulo: "Confianza mínima para responder una consulta",
        queHace:
          "Por debajo de esto, Migue prefiere decir que no sabe y registrar la pregunta en " +
          "«Sin responder» antes que arriesgar una respuesta.",
        tipo: "decimal",
        minimo: 0,
        maximo: 1,
        consecuencia: "alta",
      },
      {
        clave: "umbral_confianza_router",
        rotulo: "Confianza mínima para arrancar un trámite",
        queHace:
          "Por debajo de esto, en vez de arrancar un trámite Migue muestra el menú y pregunta.",
        tipo: "decimal",
        minimo: 0,
        maximo: 1,
      },
      {
        clave: "responder_antes_de_preguntar",
        rotulo: "Intentar responder antes de mostrar el menú",
        queHace:
          "Con esto activado, ante una consulta dudosa Migue primero busca una respuesta; " +
          "desactivado, va directo al menú.",
        tipo: "booleano",
      },
      {
        clave: "expansion_consulta_activa",
        rotulo: "Reformular la consulta antes de buscar",
        queHace:
          "Migue reescribe lo que preguntó el vecino con palabras del expediente antes de " +
          "buscar. Encuentra más, pero cuesta una llamada al modelo por consulta.",
        tipo: "booleano",
      },
      {
        clave: "max_fragmentos_contexto",
        rotulo: "Cuánto material lee para redactar",
        queHace:
          "Cuántos fragmentos de documento o preguntas frecuentes se le pasan al modelo. Más " +
          "material puede dar mejores respuestas y cuesta más por consulta.",
        tipo: "entero",
        minimo: 1,
        maximo: 20,
        unidad: "fragmentos",
      },
    ],
  },
  {
    rotulo: "Los modelos que usa",
    explicacion:
      "Dos modelos distintos: uno chico y barato que sólo clasifica de qué se trata el mensaje, " +
      "y uno más capaz que redacta la respuesta. Cambiarlos cambia el costo y la calidad de " +
      "todo lo que Migue dice.",
    claves: [
      {
        clave: "modelo_respuesta",
        rotulo: "Modelo que redacta las respuestas",
        queHace: "El que escribe lo que lee el vecino. Identificador de OpenRouter.",
        tipo: "texto",
        siSeRompe:
          "Un identificador que OpenRouter no reconozca hace que toda consulta libre falle. " +
          "Los trámites guiados siguen funcionando, porque no usan el modelo.",
        consecuencia: "alta",
      },
      {
        clave: "modelo_router",
        rotulo: "Modelo que clasifica los mensajes",
        queHace: "El que decide si un mensaje es un pedido, un reclamo o una consulta.",
        tipo: "texto",
        siSeRompe:
          "Si falla, Migue deja de entender de qué se trata cada mensaje y muestra el menú " +
          "siempre.",
        consecuencia: "alta",
      },
    ],
  },
  {
    rotulo: "Otras",
    explicacion: "",
    claves: [
      {
        clave: "empresa_recoleccion",
        rotulo: "Empresa de recolección",
        queHace:
          "El nombre que Migue usa al confirmar un pedido. Reemplaza el marcador {empresa} en " +
          "los mensajes de confirmación.",
        tipo: "texto",
        consecuencia: "alta",
      },
      {
        clave: "conversacion_ventana_horas",
        rotulo: "Cuánto dura una conversación",
        queHace:
          "Después de este tiempo sin mensajes, el próximo mensaje del vecino empieza una " +
          "conversación nueva en lugar de continuar la anterior.",
        tipo: "entero",
        minimo: 1,
        maximo: 168,
        unidad: "horas",
      },
      {
        clave: "tipo_cambio_usd_ars",
        rotulo: "Tipo de cambio, para leer el costo en pesos",
        queHace:
          "Cuántos pesos vale un dólar. El costo de la IA llega de OpenRouter en dólares; el " +
          "tablero lo convierte con este valor y muestra siempre al lado la cotización usada y " +
          "desde cuándo está cargada. En 0 no convierte nada y pide que se cargue. " +
          "Es la única regla de esta pantalla que NO cambia nada de lo que recibe el vecino: " +
          "sólo afecta cómo se lee el tablero.",
        tipo: "decimal",
        minimo: 0,
        // Un tope alto pero finito: sirve para atajar el cero de más al tipear,
        // que convertiría un gasto de diez dólares en catorce millones de pesos.
        maximo: 1_000_000,
        unidad: "pesos por dólar",
        siSeRompe:
          "Con un valor equivocado el tablero muestra pesos que no son. No afecta al bot ni a " +
          "ningún vecino, pero sí a cualquier presupuesto que se saque de esa pantalla.",
      },
      {
        clave: "exclusiones_durante_flujo",
        rotulo: "Interrumpir un trámite si hay una urgencia",
        queHace:
          "Con esto activado, si alguien escribe «hay olor a gas» en medio de un pedido de " +
          "escombros, Migue lo deriva ya en lugar de seguir preguntándole cuántas bolsas tiene.",
        tipo: "booleano",
        consecuencia: "alta",
      },
    ],
  },
  {
    rotulo: "No conectadas",
    explicacion:
      "Estas claves están en la base y el código NO las lee. Cambiarlas no hace nada. Se " +
      "muestran igual, marcadas, porque una clave escondida vuelve a aparecer la próxima vez " +
      "que alguien mire la tabla y ahí nadie sabe por qué no funcionaba.",
    claves: [
      {
        clave: "foto_obligatoria_retiro",
        rotulo: "Exigir foto en un pedido de retiro",
        queHace: "Debería definir si la foto es obligatoria para pedir un retiro.",
        tipo: "booleano",
        huerfana:
          "El comportamiento está fijo en el código: el flujo de retiro arranca pidiendo la " +
          "foto y la repite hasta cuatro veces. Ponerlo en «no» no cambia nada.",
      },
      {
        clave: "foto_sugerida_reclamo",
        rotulo: "Sugerir foto en un reclamo",
        queHace: "Debería definir si en un reclamo se pide una foto.",
        tipo: "booleano",
        huerfana:
          "El comportamiento está fijo en el código: el reclamo guarda la foto si la manda, y " +
          "nunca la exige.",
      },
      {
        clave: "marcadores_disponibles",
        rotulo: "Marcadores disponibles",
        queHace: "Era la lista de marcadores que el panel ofrecía al editar los textos.",
        tipo: "lista",
        huerfana:
          "Ya no se usa, y se dejó de usar a propósito: afirmaba que los cuatro marcadores " +
          "servían en cualquier mensaje, y en realidad sólo se reemplazan en los dos mensajes " +
          "de confirmación de un trámite. Ahora eso lo sabe el código del bot y cada frase lo " +
          "dice al editarla, en «Conocimiento › Cómo habla Migue».",
      },
    ],
  },
];

/** Todas las definiciones, indexadas. */
export const DEFINICIONES: ReadonlyMap<string, DefinicionClave> = new Map(
  GRUPOS_DE_REGLAS.flatMap((g) => g.claves).map((d) => [d.clave, d]),
);

export type Validacion =
  | { readonly ok: true; readonly valor: unknown }
  | { readonly ok: false; readonly mensaje: string };

/**
 * Valida y convierte lo que se escribió en el campo al `jsonb` que va a la base.
 *
 * Devuelve el valor ya tipado, no el texto: la columna es `jsonb` y guardar
 * `"72"` cuando el código espera `72` funciona por casualidad —`Number("72")` da
 * 72— hasta que alguien escribe `"setenta y dos"`. El tipo se decide acá.
 */
export function validarValor(def: DefinicionClave, crudo: string): Validacion {
  const texto = crudo.trim();

  switch (def.tipo) {
    case "booleano":
      if (texto === "true") return { ok: true, valor: true };
      if (texto === "false") return { ok: true, valor: false };
      return { ok: false, mensaje: "Tiene que ser sí o no." };

    case "opcion": {
      const valida = (def.opciones ?? []).some((o) => o.valor === texto);
      return valida
        ? { ok: true, valor: texto }
        : {
            ok: false,
            mensaje: `Tiene que ser uno de: ${(def.opciones ?? []).map((o) => o.valor).join(", ")}.`,
          };
    }

    case "entero":
    case "decimal": {
      if (texto === "") return { ok: false, mensaje: "No puede quedar vacío." };
      // Se rechaza con una expresión y no con `Number()`: `Number("")` da 0,
      // `Number(" 5 ")` da 5, y `Number("5abc")` da NaN pero `parseInt` daría 5.
      const patron = def.tipo === "entero" ? /^-?\d+$/ : /^-?\d+([.,]\d+)?$/;
      if (!patron.test(texto)) {
        return {
          ok: false,
          mensaje:
            def.tipo === "entero"
              ? "Tiene que ser un número entero, sin coma."
              : "Tiene que ser un número. Se puede usar coma o punto.",
        };
      }
      const n = Number(texto.replace(",", "."));
      if (!Number.isFinite(n)) return { ok: false, mensaje: "No es un número válido." };
      if (def.minimo !== undefined && n < def.minimo) {
        return { ok: false, mensaje: `No puede ser menor que ${def.minimo}.` };
      }
      if (def.maximo !== undefined && n > def.maximo) {
        return { ok: false, mensaje: `No puede ser mayor que ${def.maximo}.` };
      }
      return { ok: true, valor: n };
    }

    case "texto":
      if (texto === "") return { ok: false, mensaje: "No puede quedar vacío." };
      return { ok: true, valor: texto };

    case "lista": {
      // Vacío es una lista vacía y es válido: «no hay feriados cargados».
      if (texto === "") return { ok: true, valor: [] };
      const items = texto
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter((x) => x !== "");

      if (def.clave === "feriados") {
        // Se valida la FORMA y también que la fecha exista. «2026-02-30» pasa
        // una expresión regular y no es un día: `Date` lo acepta y rueda a marzo,
        // así que el feriado se aplicaría al día equivocado.
        const malas = items.filter((f) => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return true;
          const d = new Date(`${f}T00:00:00Z`);
          return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== f;
        });
        if (malas.length > 0) {
          return {
            ok: false,
            mensaje: `Estas no son fechas válidas: ${malas.join(", ")}. El formato es 2026-12-25.`,
          };
        }
      }
      return { ok: true, valor: items };
    }
  }
}

/** El valor de la base como texto editable. */
export function aTexto(def: DefinicionClave, valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (def.tipo === "lista") {
    return Array.isArray(valor) ? valor.join("\n") : String(valor);
  }
  if (def.tipo === "booleano") return valor === true ? "true" : "false";
  if (typeof valor === "string") return valor;
  return JSON.stringify(valor);
}

/**
 * El bot cachea el catálogo un minuto, y el panel no puede invalidarlo.
 *
 * `invalidarCatalogo()` existe en el dominio pero no está expuesta por ninguna
 * ruta ni RPC. Está bien así —un minuto no es nada— pero la pantalla tiene que
 * decirlo, o alguien guarda, prueba en Telegram tres segundos después, ve el
 * valor viejo y concluye que no se guardó.
 */
export const SEGUNDOS_DE_CACHE = 60;

/**
 * Convierte lo que se escriba en un enlace de WhatsApp que funcione.
 *
 * Existe porque pedirle a alguien que arme
 * `https://wa.me/5493812067777` a mano es pedirle que se equivoque. El formato
 * internacional argentino para celulares tiene dos trampas que no son obvias:
 *
 *   · va `54` (país) y después un `9` que NO está en el número que uno marca;
 *   · el `15` que se usa para llamar dentro del país NO va.
 *
 * Así que `3812067777` —como figura en una agenda— se convierte en
 * `5493812067777`. Y si alguien pega el enlace completo, se respeta.
 *
 * Devuelve null si no se puede interpretar, y la pantalla lo dice en vez de
 * guardar algo que no va a abrir ninguna conversación.
 */
export function enlaceDeWhatsapp(crudo: string): string | null {
  const texto = crudo.trim();
  if (texto === "") return null;

  // Ya es un enlace: se respeta tal cual. Puede ser wa.me, api.whatsapp.com, o
  // incluso un enlace a otra cosa si el área decide derivar a una web.
  if (/^https?:\/\//i.test(texto)) return texto;

  let d = texto.replace(/\D/g, "");
  if (d === "") return null;

  // El 0 de larga distancia nacional no va.
  if (d.startsWith("0")) d = d.slice(1);

  // Ya viene con país y el 9 de celular.
  if (d.startsWith("549")) {
    return d.length >= 12 ? `https://wa.me/${d}` : null;
  }

  // Viene con país pero sin el 9. Se agrega: sin eso WhatsApp no encuentra el
  // número, y el error que da es «número inválido», que no explica nada.
  if (d.startsWith("54")) {
    const resto = d.slice(2).replace(/^9/, "");
    return resto.length >= 9 ? `https://wa.me/549${resto}` : null;
  }

  // Un número nacional, con o sin el 15. `3812067777` o `38115206777`.
  const sinQuince = d.replace(/^(\d{2,4})15/, "$1");
  if (sinQuince.length >= 9 && sinQuince.length <= 11) {
    return `https://wa.me/549${sinQuince}`;
  }

  return null;
}

/** El número, para mostrarlo legible al lado del enlace. */
export function numeroDelEnlace(enlace: string): string | null {
  const m = /wa\.me\/(\d+)/.exec(enlace);
  if (!m) return null;
  const d = m[1]!;
  // 549 + area + numero. Se separa para que se pueda comparar con una agenda.
  const nacional = d.replace(/^549/, "");
  if (nacional.length < 9) return null;
  const area = nacional.slice(0, nacional.length - 7);
  return `+54 9 ${area} ${nacional.slice(-7, -4)}-${nacional.slice(-4)}`;
}
