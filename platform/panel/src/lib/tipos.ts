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
