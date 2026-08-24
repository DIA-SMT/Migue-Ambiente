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
