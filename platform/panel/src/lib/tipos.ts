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
            etiqueta: `${d.cantidad_fragmentos} fragmentos`,
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
