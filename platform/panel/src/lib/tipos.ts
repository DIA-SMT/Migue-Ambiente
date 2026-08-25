/**
 * Tipos de las tablas que toca el panel.
 *
 * Escritos a mano y no generados. El proyecto no tiene tipos generados de
 * Supabase, y para las cinco tablas del panel son unas cuarenta columnas:
 * generarlos exigiría sumar la CLI de Supabase al flujo de trabajo y un paso de
 * regeneración que se va a olvidar. Escribirlos acá los deja al lado del código
 * que los usa.
 *
 * REGLA: los nombres de columna van EN INGLÉS y en snake_case, tal como están
 * en la base. Traducirlos acá obligaría a un mapeo en cada consulta y a
 * recordar de qué lado del mapeo estoy. El nombre de la propiedad tiene que
 * poder buscarse en las migraciones.
 */

/** `documentos.estado` — el check de la migración 002. */
export type EstadoDocumento = "pendiente" | "procesando" | "listo" | "error";

/** `documentos.formato` — el check de la migración 002. */
export type FormatoDocumento = "pdf" | "docx" | "txt" | "md";

export interface Documento {
  id: string;
  titulo: string;
  descripcion: string | null;
  nombre_archivo: string;
  formato: FormatoDocumento;
  ruta_storage: string;
  bytes: number;
  hash_sha256: string | null;
  paginas: number | null;
  estado: EstadoDocumento;
  error_detalle: string | null;
  cantidad_fragmentos: number;
  activo: boolean;
  subido_por: string | null;
  creado_en: string;
  actualizado_en: string;
}

export interface Fragmento {
  id: string;
  orden: number;
  texto: string;
  pagina: number | null;
  titulo_seccion: string | null;
  tokens_aprox: number | null;
}

/** `trabajos` — la cola que consume el worker. */
export interface Trabajo {
  id: string;
  tipo: string;
  estado: "pendiente" | "tomado" | "listo" | "error";
  intentos: number;
  max_intentos: number;
  error_detalle: string | null;
  creado_en: string;
  finalizado_en: string | null;
  tomado_por: string | null;
}

/** Lo que devuelve `personal_nombres()`: sin el correo, a propósito. */
export interface PersonaNombre {
  usuario_id: string;
  nombre: string | null;
  rol: "operador" | "supervisor" | "admin";
}

/**
 * Cuánto puede quedarse un documento en pendiente o procesando antes de que
 * haya que sospechar.
 *
 * `recuperar_trabajos_colgados` (migración 006) devuelve el trabajo a la cola
 * pasados 15 minutos, pero NO toca `documentos.estado`. Así que un worker que
 * muere deja el documento en «procesando» para siempre, y sin este umbral el
 * panel mostraría un spinner eterno. Un panel que miente es peor que uno que no
 * muestra nada.
 */
export const MINUTOS_PARA_SOSPECHAR = 15;

export interface EstadoVisible {
  readonly etiqueta: string;
  readonly tono: "ok" | "curso" | "pend" | "alerta";
  /** Si conviene ofrecer el botón de reintentar. */
  readonly reintentable: boolean;
  readonly detalle: string | null;
}

/**
 * Traduce el estado de la base a algo que entienda quien no programa.
 *
 * «procesando» no le dice nada a nadie del área. Y el conteo de fragmentos en
 * la etiqueta es el dato que realmente importa: un documento «listo» con 0
 * fragmentos no está listo para nada.
 */
export function estadoVisible(d: Documento, ahora = Date.now()): EstadoVisible {
  const minutosQuieto = (ahora - new Date(d.actualizado_en).getTime()) / 60_000;
  const enCurso = d.estado === "pendiente" || d.estado === "procesando";

  if (enCurso && minutosQuieto > MINUTOS_PARA_SOSPECHAR) {
    return {
      etiqueta: "parece colgado",
      tono: "alerta",
      reintentable: true,
      detalle:
        `Hace ${Math.round(minutosQuieto)} minutos que no avanza. ` +
        `Lo más probable es que el worker se haya reiniciado a mitad del trabajo.`,
    };
  }

  switch (d.estado) {
    case "pendiente":
      return { etiqueta: "en cola", tono: "pend", reintentable: false, detalle: null };
    case "procesando":
      return { etiqueta: "leyendo el archivo", tono: "curso", reintentable: false, detalle: null };
    case "listo":
      return d.cantidad_fragmentos > 0
        ? {
            // Singular cuando corresponde. Se ve poco pero se ve: un documento
            // con un solo fragmento decía «1 fragmentos».
            etiqueta: `${d.cantidad_fragmentos} ${d.cantidad_fragmentos === 1 ? "fragmento" : "fragmentos"}`,
            tono: "ok",
            reintentable: false,
            detalle: null,
          }
        : {
            etiqueta: "sin contenido",
            tono: "alerta",
            reintentable: true,
            detalle: "Se leyó el archivo pero no salió ningún fragmento indexable.",
          };
    case "error":
      return {
        etiqueta: "no se pudo leer",
        tono: "alerta",
        reintentable: true,
        detalle: d.error_detalle,
      };
  }
}

/** Tamaño legible. Los documentos del corpus van de 8 KB a 8 MB. */
export function tamanoLegible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fecha corta en formato local, sin la hora cuando no aporta. */
export function fechaLegible(iso: string, conHora = false): string {
  const f = new Date(iso);
  const fecha = f.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  if (!conHora) return fecha;
  return `${fecha} ${f.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`;
}

/* ------------------------------------------------------------- respuestas --- */

/**
 * Una FAQ: la busca el buscador y el modelo redacta con ella.
 *
 * `buscar_conocimiento` le da el doble de peso que a un fragmento de PDF
 * (p_impulso_faq = 2.0): una respuesta escrita por alguien del área ya está
 * redactada para un vecino y alguien la revisó.
 */
export interface Faq {
  id: string;
  pregunta: string;
  respuesta: string;
  etiquetas: string[];
  activa: boolean;
  veces_usada: number;
  creada_por: string | null;
  creado_en: string;
  actualizado_en: string;
}

/** Modos de coincidencia de una respuesta fija. Check de la migración 002. */
export type ModoDisparador = "exacto" | "contiene" | "regex";

/**
 * Una respuesta fija: se envía TEXTUAL, sin pasar por el modelo.
 *
 * Es para lo que no admite interpretación —un teléfono, una dirección, una
 * suspensión de servicio—. La contracara es que si el disparador está mal, el
 * vecino recibe una respuesta que no tiene nada que ver.
 */
export interface RespuestaFija {
  id: string;
  nombre: string;
  disparadores: string[];
  modo: ModoDisparador;
  respuesta: string;
  prioridad: number;
  activa: boolean;
  veces_usada: number;
  notas: string | null;
  creada_por: string | null;
  creado_en: string;
  actualizado_en: string;
}

/** Lo que devuelve `probar_disparadores`. */
export interface PruebaDisparadores {
  coincide_el_texto: boolean;
  mensajes_mirados: number;
  mensajes_atrapados: number;
  ejemplos: string[];
}

/** Lo que devuelve `probar_conocimiento`, igual que lo que ve el bot. */
export interface Coincidencia {
  origen: "faq" | "fragmento" | "respuesta_fija";
  id: string;
  titulo: string | null;
  texto: string;
  documento_titulo: string | null;
  pagina: number | null;
  rank: number;
  difuso: boolean;
}

/**
 * Qué tan riesgoso es un disparador, según cuántos mensajes reales atrapa.
 *
 * El umbral en un tercio no es arbitrario: una respuesta fija que se dispara en
 * más de un tercio de lo que escribe la gente ya no es una respuesta a una
 * pregunta puntual, es el comportamiento por defecto del bot. Y ese no se
 * configura desde acá.
 */
export function riesgoDelDisparador(p: PruebaDisparadores): {
  tono: "ok" | "curso" | "alerta";
  mensaje: string;
} {
  if (p.mensajes_mirados === 0) {
    return {
      tono: "curso",
      mensaje: "Todavía no hay mensajes de vecinos con los que comparar.",
    };
  }
  const proporcion = p.mensajes_atrapados / p.mensajes_mirados;

  if (proporcion >= 0.34) {
    return {
      tono: "alerta",
      mensaje:
        `Atrapa ${p.mensajes_atrapados} de los últimos ${p.mensajes_mirados} mensajes. ` +
        `Eso es demasiado: dejaría de ser una respuesta puntual y pasaría a ser lo que el bot ` +
        `contesta casi siempre.`,
    };
  }
  if (p.mensajes_atrapados === 0) {
    return {
      tono: "curso",
      mensaje:
        `No coincide con ninguno de los últimos ${p.mensajes_mirados} mensajes. ` +
        `Puede estar bien si es para algo que todavía nadie preguntó, pero conviene revisar ` +
        `que la palabra sea la que usa la gente.`,
    };
  }
  return {
    tono: "ok",
    mensaje: `Atrapa ${p.mensajes_atrapados} de los últimos ${p.mensajes_mirados} mensajes.`,
  };
}

/* ------------------------------------------------- pedidos y reclamos --- */

export interface Ticket {
  id: string;
  ticket_type: string;
  status: string;
  address: string | null;
  user_name: string | null;
  chat_id: string | null;
  channel: string | null;
  waste_type: string | null;
  quantity: string | null;
  quantity_value: number | null;
  quantity_unit: string | null;
  exceeds_limit: boolean | null;
  partial_pickup: boolean | null;
  days_without_service: number | null;
  derived_to: string | null;
  photo_ref: string | null;
  photo_url: string | null;
  notes: string | null;
  sla_deadline: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  conversation_id: string | null;
}

export interface SolicitudPrograma {
  id: string;
  program_type: string;
  status: string;
  institution_name: string | null;
  responsible_person: string | null;
  contact_phone: string | null;
  student_count: number | null;
  address: string | null;
  preferred_time: string | null;
  additional_info: string | null;
  user_name: string | null;
  chat_id: string | null;
  channel: string | null;
  // La 012 se las agregó a las dos tablas: TRANSFORMÁ recibe fotos de
  // relevamiento del espacio a intervenir.
  photo_ref: string | null;
  photo_url: string | null;
  created_at: string;
  resolved_at: string | null;
  conversation_id: string | null;
}

/**
 * Los estados a los que el panel puede mover un ticket.
 *
 * `tickets.status` es texto libre sin restricción, y en la base hay valores que
 * dejó el bot anterior: "Pendiente Validación Imagen" en 15 de 20 tickets, y
 * "Pendiente Verificación GPS" en otro. El panel los MUESTRA tal como están
 * —esconderlos sería mentir sobre lo que hay— pero para moverlos ofrece esta
 * lista corta. Así se van normalizando sin una migración que decida por el área
 * qué significaba cada estado viejo.
 */
export const ESTADOS_TICKET = [
  "En Proceso",
  "Derivado",
  "Resuelto",
  "No corresponde",
] as const;

export const ESTADOS_PROGRAMA = ["Pendiente", "Contactado", "Coordinado", "Resuelto"] as const;

/** Un estado que el panel no ofrece: viene del bot anterior. */
export function esEstadoHeredado(estado: string): boolean {
  return !(ESTADOS_TICKET as readonly string[]).includes(estado);
}

/**
 * Estados en los que el caso ya no espera nada de nadie.
 *
 * Se usa para no mostrar como vencido algo que ya se cerró. Al cerrar desde el
 * panel se sella `resolved_at`, pero los casos del bot anterior tienen el estado
 * puesto y la fecha en null.
 */
const TERMINALES: readonly string[] = ["Resuelto", "No corresponde", "Cerrado"];

export function esEstadoTerminal(estado: string): boolean {
  return TERMINALES.includes(estado);
}

/**
 * ¿El caso ya se cerró?
 *
 * UNA sola función para esto, y la razón es concreta: había dos lugares
 * preguntándolo de formas distintas —uno miraba `resolved_at`, el otro el
 * estado— y con los tickets del bot anterior daban resultados distintos. La
 * bandeja decía «20 abiertos» y «13 vencidos» sobre los mismos datos, contando
 * un ticket resuelto como abierto.
 */
export function estaCerrado(c: { status: string; resolved_at: string | null }): boolean {
  return c.resolved_at !== null || esEstadoTerminal(c.status);
}

export interface SituacionSla {
  readonly etiqueta: string;
  readonly tono: "ok" | "curso" | "pend" | "alerta";
  /** Para ordenar: lo más urgente primero. */
  readonly urgencia: number;
}

/**
 * Cómo está un caso contra el plazo que el bot ya le prometió al vecino.
 *
 * El plazo NO es una meta interna: el texto de confirmación le dice al vecino
 * una fecha concreta. Que se venza es una promesa incumplida, y por eso esta
 * pantalla ordena por esto y no por fecha de creación.
 */
export function situacionSla(t: Ticket, ahora = Date.now()): SituacionSla {
  // Se miran las DOS cosas, y hace falta: el bot anterior dejó tickets con
  // estado «Resuelto» y `resolved_at` en null. Mirando sólo la fecha, ese ticket
  // aparecía abierto y vencido hace medio año en la bandeja del área.
  //
  // El panel, cuando cierra un caso, sella la fecha; así que a futuro las dos
  // señales coinciden. Esto es para los que ya estaban.
  if (estaCerrado(t)) {
    return { etiqueta: "resuelto", tono: "ok", urgencia: 4 };
  }
  if (t.sla_deadline === null) {
    // Los tickets del bot anterior no tienen plazo cargado. Calcularlo hacia
    // atrás sería mostrar una fecha que nadie le prometió a nadie.
    return { etiqueta: "sin plazo", tono: "pend", urgencia: 3 };
  }

  const horas = (new Date(t.sla_deadline).getTime() - ahora) / 3_600_000;

  if (horas < 0) {
    const dias = Math.floor(-horas / 24);
    return {
      etiqueta: dias >= 1 ? `vencido hace ${dias} día${dias === 1 ? "" : "s"}` : "vencido",
      tono: "alerta",
      urgencia: 0,
    };
  }
  if (horas < 24) {
    return { etiqueta: `vence en ${Math.max(1, Math.round(horas))} h`, tono: "curso", urgencia: 1 };
  }
  return { etiqueta: `${Math.round(horas / 24)} días`, tono: "ok", urgencia: 2 };
}

/**
 * Qué datos le faltan a un ticket.
 *
 * Es el caso de los 17 tickets que dejó el bot anterior: sin tipo de residuo ni
 * cantidad. Un caso a medias no se puede resolver, y quien lo abre tiene que ver
 * qué falta antes de intentarlo.
 */
export function datosFaltantes(t: Ticket): string[] {
  const faltan: string[] = [];
  if (!t.address) faltan.push("dirección");
  if (t.ticket_type === "Pedido No Habitual") {
    if (!t.waste_type) faltan.push("tipo de residuo");
    if (t.quantity_value === null && !t.quantity) faltan.push("cantidad");
    if (!t.photo_ref && !t.photo_url) faltan.push("foto");
  }
  return faltan;
}

/* ------------------------------------------------- preguntas sin responder --- */

/**
 * Por qué Migue no supo contestar. Cada motivo pide una acción distinta, y por
 * eso se guarda el motivo y no sólo el hecho de que falló:
 *
 *   sin_coincidencia   el buscador no encontró NADA. Falta material: hay que
 *                      escribir una respuesta o cargar el documento.
 *   confianza_baja     encontró algo pero flojo. Suele significar que existe la
 *                      información pero está redactada con otras palabras.
 *   fuera_de_alcance   se DERIVÓ a Migue, el asistente general del municipio.
 *                      Desde la 026 el bot no repite el menú: si el vecino
 *                      insiste con algo que no es de Ambiente, lo manda al otro
 *                      número y registra la pregunta acá. Lo que hay que decidir
 *                      no es qué escribir, es si estuvo bien derivado.
 *   error_modelo       falló el proveedor. No es un problema de contenido y no
 *                      hay que responderlo: es para mirar en Métricas.
 */
export type MotivoSinRespuesta =
  | "sin_coincidencia"
  | "confianza_baja"
  | "fuera_de_alcance"
  | "error_modelo";

export type EstadoSinRespuesta = "pendiente" | "resuelta" | "descartada";

/** Una fila de `v_sin_respuesta` (migración 021). */
export interface PreguntaSinResponder {
  id: string;
  pregunta: string;
  motivo: MotivoSinRespuesta;
  confianza: number | null;
  veces_repetida: number;
  estado: EstadoSinRespuesta;
  notas: string | null;
  creado_en: string;
  actualizado_en: string;
  resuelta_con_faq_id: string | null;
  resuelta_con_fija_id: string | null;
  respuesta_titulo: string | null;
  respuesta_publicada: boolean | null;
  respuesta_tipo: "faq" | "fija" | null;
}

export const MOTIVOS_SIN_RESPUESTA: Record<
  MotivoSinRespuesta,
  { etiqueta: string; tono: string; queHacer: string; accionable: boolean }
> = {
  sin_coincidencia: {
    etiqueta: "no encontró nada",
    tono: "alerta",
    queHacer: "Falta material sobre el tema. Escribir una respuesta es lo más directo.",
    accionable: true,
  },
  confianza_baja: {
    etiqueta: "encontró poco",
    tono: "curso",
    queHacer:
      "Probablemente la información exista pero con otras palabras. Una pregunta frecuente escrita como la hace el vecino lo arregla.",
    accionable: true,
  },
  fuera_de_alcance: {
    etiqueta: "derivada a Migue",
    tono: "pend",
    // EL REENCUADRE DE LA 026. Antes esto decía «no hay nada que responder».
    // Ahora el bot ya derivó al vecino al asistente general del municipio, y la
    // pregunta que le queda al área es distinta —y más útil— que «hay que
    // escribir esto»: es si la derivación estuvo bien.
    //
    // Importa porque las dos respuestas correctas son OPUESTAS: escribir la
    // respuesta, o no hacer nada. Presentarlo como «falta escribir esto» empuja
    // a redactar una pregunta frecuente sobre licencias de conducir.
    queHacer:
      "El bot ya lo mandó a Migue, el asistente general. La pregunta acá es otra: ¿esto era " +
      "nuestro y lo derivamos mal? Si era nuestro, escribí la respuesta y la próxima vez lo " +
      "atendemos. Si no era nuestro, marcalo como bien derivado.",
    accionable: true,
  },
  error_modelo: {
    etiqueta: "falló el proveedor",
    tono: "alerta",
    queHacer:
      "No es un problema de contenido: escribir una respuesta no lo arregla. Se revisa en Métricas.",
    accionable: false,
  },
};

/**
 * Qué mostrar del estado de una pregunta.
 *
 * El caso que importa es el tercero: una pregunta marcada «resuelta» cuya
 * respuesta quedó en borrador NO está contestada — el vecino que vuelva a
 * preguntar lo mismo va a fallar igual. Sin distinguirlo, la lista dice que el
 * trabajo está hecho cuando falta el paso que lo hace servir.
 */
export function estadoDeLaPregunta(p: PreguntaSinResponder): {
  etiqueta: string;
  tono: string;
  detalle: string | null;
} {
  if (p.estado === "descartada") {
    return { etiqueta: "descartada", tono: "pend", detalle: p.notas };
  }
  if (p.estado === "resuelta") {
    if (p.respuesta_tipo === null) {
      // Se marcó resuelta sin vincular nada. Pasa si alguien la resolvió por
      // fuera del panel; queda visible en vez de darla por buena.
      return { etiqueta: "resuelta sin respuesta vinculada", tono: "curso", detalle: p.notas };
    }
    return p.respuesta_publicada
      ? { etiqueta: "respondida", tono: "ok", detalle: p.respuesta_titulo }
      : {
          etiqueta: "falta publicar",
          tono: "alerta",
          detalle: `El borrador «${p.respuesta_titulo}» está escrito pero Migue todavía no lo usa.`,
        };
  }
  return { etiqueta: "pendiente", tono: "curso", detalle: null };
}

/* ------------------------------------------------------ conversaciones --- */

export type CanalConversacion = "telegram" | "whatsapp" | "web";
export type EstadoConversacion = "abierta" | "cerrada" | "derivada" | "abandonada";

/** Una fila de `v_conversaciones` (migración 023). */
export interface Conversacion {
  id: string;
  canal: CanalConversacion;
  // `canal_usuario_id` NO está, y la ausencia es deliberada: en WhatsApp es el
  // teléfono del vecino, ningún componente lo usaba, y viajaba a cada navegador
  // que abre la lista. La 023 lo sacó de la vista.
  nombre_usuario: string | null;
  estado: EstadoConversacion;
  flujo_activo: string | null;
  cantidad_mensajes: number;
  iniciada_en: string;
  ultima_actividad_en: string;
  votos_utiles: number;
  votos_no_utiles: number;
  ultimo_comentario: string | null;
  primer_mensaje: string | null;
  /**
   * Las que todavía nadie resolvió. Es la accionable: baja cuando el área
   * escribe la respuesta.
   *
   * Antes había una sola columna, `preguntas_sin_responder`, que contaba TODAS
   * las filas de `sin_respuesta` sin mirar el estado. El número era monótono
   * creciente: hacer el trabajo no lo bajaba. Es la misma forma del bug que
   * hizo que una pantalla dijera «20 abiertos» y «13 vencidos» sobre las
   * mismas filas.
   */
  preguntas_pendientes: number;
  /**
   * Todas las que alguna vez fallaron, resueltas incluidas.
   *
   * Historia, no tarea. Va aparte y con otro nombre porque una sola columna que
   * se puede leer de las dos maneras es cómo nació el bug.
   */
  preguntas_falladas: number;
}

/** Una fila de `transcripcion(id)` (migración 022). */
export interface MensajeTranscripto {
  id: string;
  direccion: "entrante" | "saliente";
  texto: string | null;
  media_tipo: string | null;
  media_ruta: string | null;
  intencion: string | null;
  confianza: number | null;
  origen_respuesta: string | null;
  costo_usd: number | null;
  creado_en: string;
  voto: "util" | "no_util" | null;
  comentario: string | null;
}

/**
 * Cómo le fue a esta conversación, en una etiqueta.
 *
 * El orden de las ramas ES la política de qué mirar primero, y la primera es la
 * que importa: un pulgar abajo pesa más que cualquier otra señal, porque es el
 * vecino diciendo explícitamente que no le servimos. Todo lo demás son
 * inferencias nuestras; eso es un dato.
 *
 * Y un pulgar abajo no se compensa con dos arriba. Una charla donde Migue
 * acertó dos veces y falló una vez sigue teniendo una falla que hay que
 * arreglar: promediarlas la escondería.
 */
export function comoLeFue(c: Conversacion): {
  etiqueta: string;
  tono: string;
  urgencia: number;
} {
  if (c.votos_no_utiles > 0) {
    return {
      etiqueta:
        c.votos_no_utiles === 1 ? "no le sirvió" : `no le sirvió (${c.votos_no_utiles})`,
      tono: "alerta",
      urgencia: 0,
    };
  }
  if (c.preguntas_pendientes > 0) {
    // No votó, pero el bot no supo contestarle. Es una falla igual, sólo que
    // detectada por nosotros y no reportada por el vecino.
    //
    // Se mira la PENDIENTE y no el total: una pregunta que alguien ya resolvió
    // no es una tarea abierta, y contarla dejaba esta etiqueta pegada para
    // siempre.
    return {
      etiqueta:
        c.preguntas_pendientes === 1
          ? "quedó una sin responder"
          : `quedaron ${c.preguntas_pendientes} sin responder`,
      tono: "curso",
      urgencia: 1,
    };
  }
  // Falló y ya se arregló. Vale distinguirlo de una charla que salió bien de
  // entrada: no es una tarea, pero tampoco es un éxito.
  if (c.preguntas_falladas > 0 && c.votos_no_utiles === 0) {
    return { etiqueta: "falló y se resolvió", tono: "pend", urgencia: 2 };
  }
  if (c.votos_utiles > 0) {
    return {
      etiqueta: c.votos_utiles === 1 ? "le sirvió" : `le sirvió (${c.votos_utiles})`,
      tono: "ok",
      urgencia: 3,
    };
  }
  // Lo más común, y por eso NO dice «bien»: que nadie se haya quejado no es lo
  // mismo que haber ayudado. Decir «sin datos» es la verdad.
  return { etiqueta: "sin voto", tono: "pend", urgencia: 2 };
}

/** De dónde salió la respuesta, en palabras del área y no del esquema. */
export const ORIGENES_RESPUESTA: Record<string, string> = {
  respuesta_fija: "respuesta textual",
  faq: "pregunta frecuente",
  documentos: "documentos cargados",
  flujo: "trámite guiado",
  exclusion: "derivación automática",
  fallback: "no supo",
};

/**
 * Recorta un texto a lo que entra en una celda, cortando por palabra.
 *
 * Corta en el espacio anterior al límite y no en el carácter exacto: partir una
 * palabra al medio hace que el texto parezca dañado en vez de recortado, y en
 * una lista de preguntas de vecinos eso se lee como si el dato estuviera roto.
 */
export function recortarTexto(texto: string, maximo: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (limpio.length <= maximo) return limpio;
  const corte = limpio.lastIndexOf(" ", maximo);
  return `${limpio.slice(0, corte > maximo * 0.6 ? corte : maximo)}…`;
}

/* ---------------------------------------------------- textos del bot --- */

/**
 * Una fila de `textos_bot`: una frase fija que el bot envía tal cual.
 *
 * Las claves son FIJAS. El código las busca por nombre con `leerTexto()`, así
 * que se edita el texto pero no se agregan ni se borran filas desde el panel.
 */
export interface TextoBot {
  clave: string;
  texto: string;
  descripcion: string | null;
  /**
   * Si puede quedar vacía.
   *
   * Sale de la columna `opcional` (migración 020) y NO de una lista en el
   * código. Había una, `PUEDEN_IR_VACIAS`, con una sola clave — y ya se había
   * desincronizado: producción tiene cinco opcionales. El efecto era que vaciar
   * `seguimiento_tras_responder` para apagar el voto, que es la forma
   * documentada de apagarlo, lo rechazaba el panel con un mensaje falso.
   *
   * El resto se lee con `leerTexto()`, que devuelve «[falta texto: clave]»
   * cuando no hay nada. Vaciar una obligatoria es mandarle eso a un vecino.
   */
  opcional: boolean;
  actualizado_en: string;
}

/* --------------------------------------------------------------- reglas --- */

/** Una fila de `configuracion`. El valor es `jsonb`: puede ser cualquier cosa. */
export interface FilaConfiguracion {
  clave: string;
  valor: unknown;
  descripcion: string | null;
  actualizado_por: string | null;
  actualizado_en: string;
}

/**
 * Una fila de `limites_volumen`.
 *
 * NO tiene `id`: la clave primaria es `categoria`, y el CHECK la limita a tres
 * valores. Agregar una cuarta categoría no se puede desde el panel — hace falta
 * una migración y además tocar el tipo `Categoria` del dominio y las opciones del
 * flujo de retiro. La pantalla lo dice en vez de ofrecer un botón que fallaría
 * con un 23514.
 */
export interface FilaLimite {
  categoria: "escombros" | "poda" | "voluminosos";
  etiqueta: string;
  limite_valor: number;
  limite_unidad: string;
  peso_max_bolsa_kg: number | null;
  accion_al_exceder: "parcial_con_ticket" | "derivar_sin_ticket";
  texto_exceso: string | null;
  activo: boolean;
  palabras: string[];
  actualizado_en: string;
}

/** Una fila de `reglas_exclusion`. */
export interface FilaExclusion {
  id: string;
  nombre: string;
  palabras: string[];
  organismo: string | null;
  respuesta: string;
  accion: "derivar" | "advertir";
  prioridad: number;
  activa: boolean;
  veces_aplicada: number;
  actualizado_en: string;
}

/** Una fila de `puntos_verdes`. */
export interface FilaPuntoVerde {
  id: string;
  nombre: string | null;
  direccion: string;
  tipo: string | null;
  horario: string | null;
  materiales: string[] | null;
  observaciones: string | null;
  activo: boolean;
  orden: number;
}

/** Una fila de `zonas_recoleccion`. */
export interface FilaZona {
  id: string;
  nombre: string;
  dias: string[];
  hora_sacar: string | null;
  observaciones: string | null;
  activo: boolean;
}
