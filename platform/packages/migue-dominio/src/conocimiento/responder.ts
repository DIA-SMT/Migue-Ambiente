/**
 * La cadena que resuelve una consulta libre.
 *
 * Regla que gobierna todo el módulo: ANTE LA DUDA, NO RESPONDER. Un bot
 * municipal que inventa un horario de recolección o un límite de bolsas hace
 * más daño que uno que dice «no tengo ese dato». El vecino que recibe un dato
 * falso organiza su semana con él.
 *
 * Por eso el modelo no devuelve prosa libre: devuelve un JSON con un campo
 * explícito de si puede responder o no. Pedirle que «diga no sé si no sabe»
 * funciona mucho peor que darle un lugar donde declararlo.
 */
import { chat, parsearJson } from "../ia/cliente.ts";
import {
  leerConfig,
  leerTexto,
  valoresDeRespuestaFija,
  type Catalogo,
} from "../datos/catalogo.ts";
import { obtenerCliente } from "../datos/cliente.ts";
import {
  armarContexto,
  buscarEnConocimiento,
  buscarRespuestaFija,
  esMaterialSuficiente,
  idsDeFaqs,
  type Coincidencia,
} from "./buscar.ts";
import { interpolar, recortar } from "../texto.ts";
import type { MotivoSinRespuesta } from "../datos/registros.ts";

export interface TrazaRespuesta {
  readonly modelo: string | null;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
  readonly costoUsd: number | null;
  readonly latenciaMs: number;
  readonly consultaExpandida: string | null;
  readonly confianza: number | null;
}

// El motivo lo define la tabla `sin_respuesta`, no este módulo. Se importa en
// vez de redeclararlo: dos tipos con el mismo nombre para el mismo concepto se
// desincronizan en cuanto alguien agregue un motivo nuevo en la migración.
export type { MotivoSinRespuesta };

export type Respuesta =
  | {
      readonly tipo: "fija";
      readonly texto: string;
      readonly respuestaFijaId: string;
      readonly traza: TrazaRespuesta;
    }
  | {
      readonly tipo: "sintetizada";
      readonly texto: string;
      readonly coincidencias: readonly Coincidencia[];
      readonly traza: TrazaRespuesta;
    }
  | {
      readonly tipo: "sin_respuesta";
      readonly texto: string;
      readonly motivo: MotivoSinRespuesta;
      readonly traza: TrazaRespuesta;
    };

const TRAZA_VACIA: TrazaRespuesta = {
  modelo: null,
  tokensEntrada: 0,
  tokensSalida: 0,
  costoUsd: null,
  latenciaMs: 0,
  consultaExpandida: null,
  confianza: null,
};

// ---------------------------------------------------------------------------
// Expansión de consulta
// ---------------------------------------------------------------------------

/**
 * Reescribe la pregunta del vecino a los términos que usan los documentos.
 *
 * Es lo que hace viable la búsqueda por texto completo sin base vectorial. El
 * vecino escribe «dónde tiro las pilas»; los documentos dicen «residuos
 * especiales», «pilas y baterías», «punto verde». Sin este paso, el texto
 * completo no encuentra nada y el bot queda mudo frente a una pregunta que sí
 * tiene respuesta en el corpus.
 *
 * Si la expansión falla, se devuelve la consulta original: perder recall es
 * mucho mejor que no responder.
 */
async function expandirConsulta(
  consulta: string,
  modelo: string,
): Promise<{ terminos: string | null; traza: Partial<TrazaRespuesta> }> {
  try {
    const r = await chat({
      modelo,
      maxTokens: 120,
      temperatura: 0,
      timeoutMs: 8_000,
      // Menos reintentos que en la síntesis: si la expansión demora, conviene
      // buscar con la consulta original antes que hacer esperar al vecino.
      reintentos: 1,
      json: true,
      mensajes: [
        {
          role: "system",
          content:
            "Sos un expansor de consultas para buscar en documentos municipales de gestión " +
            "ambiental de San Miguel de Tucumán. Recibís la pregunta de un vecino y devolvés " +
            "los términos con los que buscarla en documentos institucionales.\n\n" +
            "Devolvé SOLO JSON: {\"terminos\": \"palabra1 palabra2 ...\"}\n\n" +
            "Reglas: incluí sinónimos institucionales y las palabras de la pregunta original. " +
            "Sin tildes. Sin signos. Máximo 12 palabras. No inventes nombres de programas " +
            "que no aparezcan en la pregunta.",
        },
        { role: "user", content: recortar(consulta, 500) },
      ],
    });

    const parseado = parsearJson<{ terminos?: string }>(r.texto);
    const terminos = parseado?.terminos?.trim();

    return {
      terminos: terminos && terminos.length >= 3 ? terminos : null,
      traza: {
        tokensEntrada: r.tokensEntrada,
        tokensSalida: r.tokensSalida,
        costoUsd: r.costoUsd,
        latenciaMs: r.latenciaMs,
        consultaExpandida: terminos ?? null,
      },
    };
  } catch {
    // Falla de red, timeout o clave inválida: se busca con lo que dijo el
    // vecino. Peor recall, pero el bot sigue respondiendo.
    return { terminos: null, traza: {} };
  }
}

// ---------------------------------------------------------------------------
// Cadena principal
// ---------------------------------------------------------------------------

interface RespuestaDelModelo {
  readonly puede_responder?: boolean;
  readonly respuesta?: string;
  readonly confianza?: number;
}

export async function responderConsulta(
  consulta: string,
  catalogo: Catalogo,
): Promise<Respuesta> {
  // 1 · Respuesta fija: se envía TEXTUAL, sin pasar por el modelo. Es la
  // herramienta para cuando la redacción institucional no es negociable.
  const fija = buscarRespuestaFija(consulta, catalogo);
  if (fija !== null) {
    void incrementarUsoFija(fija.id);
    return {
      tipo: "fija",
      // Se interpola contra el catálogo. Es lo que permite que una fija diga
      // «{puntos_verdes}» en vez de tener las tres direcciones copiadas
      // adentro: el dato vive UNA vez, en la tabla que el área edita en Reglas.
      //
      // `interpolar` deja intacto lo que no sabe resolver, así que un marcador
      // inventado le llega al vecino con las llaves. Es feo y es a propósito:
      // el panel lo rechaza antes de guardar, y si igual llegara, un texto
      // visiblemente roto se reporta — uno silenciosamente vacío, no.
      texto: interpolar(fija.respuesta, valoresDeRespuestaFija(catalogo)),
      respuestaFijaId: fija.id,
      traza: { ...TRAZA_VACIA, confianza: 1 },
    };
  }

  const modeloRouter = leerConfig(catalogo, "modelo_router", "openai/gpt-4o-mini");
  const modeloRespuesta = leerConfig(catalogo, "modelo_respuesta", "anthropic/claude-haiku-4.5");
  const umbral = Number(leerConfig(catalogo, "umbral_confianza", 0.55));
  const maxFragmentos = Number(leerConfig(catalogo, "max_fragmentos_contexto", 8));
  const expansionActiva = leerConfig(catalogo, "expansion_consulta_activa", true) === true;

  let traza: TrazaRespuesta = { ...TRAZA_VACIA };

  // 2 · Expansión de consulta, si está habilitada desde el panel.
  let terminosExpandidos: string | null = null;
  if (expansionActiva) {
    const { terminos, traza: trazaExp } = await expandirConsulta(consulta, modeloRouter);
    terminosExpandidos = terminos;
    traza = { ...traza, ...trazaExp };
  }

  // 3 · Búsqueda en FAQs y fragmentos.
  let coincidencias: Coincidencia[];
  try {
    coincidencias = await buscarEnConocimiento(consulta, {
      terminos: terminosExpandidos,
      limite: maxFragmentos,
    });
  } catch {
    // Si la base no responde, el bot no puede inventar. Se admite el límite.
    return sinRespuesta(catalogo, "sin_coincidencia", traza);
  }

  if (!esMaterialSuficiente(coincidencias)) {
    return sinRespuesta(catalogo, "sin_coincidencia", traza);
  }

  // 4 · Síntesis. El modelo lee SOLO el contexto recuperado.
  try {
    const r = await chat({
      modelo: modeloRespuesta,
      maxTokens: 600,
      temperatura: 0.2,
      json: true,
      mensajes: [
        { role: "system", content: instrucciones() },
        {
          role: "user",
          content:
            `CONTEXTO\n${armarContexto(coincidencias)}\n\n` +
            `PREGUNTA DEL VECINO\n${recortar(consulta, 800)}`,
        },
      ],
    });

    traza = {
      ...traza,
      modelo: r.modelo,
      tokensEntrada: traza.tokensEntrada + r.tokensEntrada,
      tokensSalida: traza.tokensSalida + r.tokensSalida,
      costoUsd: sumarCosto(traza.costoUsd, r.costoUsd),
      latenciaMs: traza.latenciaMs + r.latenciaMs,
    };

    const salida = parsearJson<RespuestaDelModelo>(r.texto);

    // Un JSON que no parsea es una falla del modelo, no una respuesta. No se
    // manda el texto crudo al vecino: podría ser cualquier cosa.
    if (salida === null) {
      return sinRespuesta(catalogo, "error_modelo", traza);
    }

    const confianza = typeof salida.confianza === "number" ? salida.confianza : null;
    traza = { ...traza, confianza };

    const texto = salida.respuesta?.trim() ?? "";

    if (salida.puede_responder !== true || texto === "") {
      return sinRespuesta(catalogo, "sin_coincidencia", traza);
    }
    if (confianza !== null && confianza < umbral) {
      return sinRespuesta(catalogo, "confianza_baja", traza);
    }

    void incrementarUsoFaqs(idsDeFaqs(coincidencias));

    return { tipo: "sintetizada", texto, coincidencias, traza };
  } catch {
    // Timeout, 429 agotado, clave inválida o red caída: todos terminan igual
    // para el vecino. Se admite el límite en vez de arriesgar un dato inventado.
    return sinRespuesta(catalogo, "error_modelo", traza);
  }
}

function instrucciones(): string {
  return [
    "Sos Migue Ambiente, el asistente de la Dirección de Ambiente de la Municipalidad de",
    "San Miguel de Tucumán. Le hablás a un vecino por chat.",
    "",
    "REGLA ABSOLUTA: respondés ÚNICAMENTE con información que esté en el CONTEXTO.",
    "Si el contexto no alcanza para responder, poné puede_responder en false. No completes",
    "con conocimiento general: un horario o un límite inventado hace que el vecino organice",
    "su semana con un dato falso.",
    "",
    "Formato: devolvé SOLO este JSON.",
    '{"puede_responder": true|false, "respuesta": "...", "confianza": 0.0-1.0}',
    "",
    "Cómo escribir la respuesta:",
    "- Español rioplatense, voseo. Tratamiento cordial y directo.",
    "- Breve: dos o tres frases salvo que la pregunta pida un listado.",
    "- Texto plano. Sin asteriscos, sin markdown, sin encabezados.",
    "- Dá el dato primero. Si hace falta aclarar algo, después.",
    "- No cites números de fragmento ni nombres de archivo: al vecino no le sirven.",
    "- Si el contexto tiene direcciones u horarios, transcribilos exactos.",
    "",
    "confianza refleja cuán bien el contexto responde la pregunta, no cuán segura suena",
    "tu redacción.",
  ].join("\n");
}

function sinRespuesta(
  catalogo: Catalogo,
  motivo: MotivoSinRespuesta,
  traza: TrazaRespuesta,
): Respuesta {
  return {
    tipo: "sin_respuesta",
    texto: leerTexto(catalogo, "sin_respuesta"),
    motivo,
    traza,
  };
}

function sumarCosto(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

// ---------------------------------------------------------------------------
// Contadores
// ---------------------------------------------------------------------------
// Se disparan sin esperar (`void`) y con el error tragado: saber que una FAQ se
// usó es útil para el panel, pero no vale hacer esperar a un vecino ni cortar
// una respuesta ya lista por un contador.

function incrementarUsoFaqs(ids: readonly string[]): void {
  if (ids.length === 0) return;
  void (async () => {
    try {
      await obtenerCliente().rpc("registrar_uso_faq", { p_ids: ids });
    } catch {
      // Es un contador para el panel. No vale cortar una respuesta por esto.
    }
  })();
}

function incrementarUsoFija(id: string): void {
  void (async () => {
    try {
      await obtenerCliente().rpc("registrar_uso_respuesta_fija", { p_id: id });
    } catch {
      // Igual que arriba.
    }
  })();
}
