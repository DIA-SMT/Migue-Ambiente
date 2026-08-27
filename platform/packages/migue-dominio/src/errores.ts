/**
 * Describir un error para que sirva en un log.
 *
 * POR QUÉ EXISTE. El idioma habitual —`error instanceof Error ? error.message
 * : String(error)`— tiene un agujero grande justo donde más duele: los errores
 * de Supabase NO son `Error`. Un `PostgrestError` es un objeto plano con
 * `message`, `code`, `details` y `hint`, así que cae en la rama del `String()`
 * y se imprime como `[object Object]`.
 *
 * No es teórico. El barrido de encuestas falló en producción el 26/08 y lo
 * único que quedó anotado fue:
 *
 *   {"mod":"encuesta","err":"[object Object]","msg":"falló el barrido"}
 *
 * Un log que no dice qué pasó es peor que no loguear: ocupa lugar y da la
 * sensación de que el problema está registrado. El mismo agujero se traga el
 * motivo por el que no se pudo crear el ticket de un vecino, que es el peor de
 * los casos posibles.
 *
 * Este módulo es puro y no importa nada: por eso puede salir también por
 * `@migue/dominio/compartido` y usarse en el navegador.
 */

/** Campos que trae un error de Supabase, y el orden en que se leen mejor. */
const CAMPOS_DE_POSTGREST = ["message", "code", "details", "hint"] as const;

/**
 * Un texto legible para cualquier cosa que haya llegado por un `catch`.
 *
 * Nunca devuelve cadena vacía ni `[object Object]`: si no puede armar nada
 * mejor, dice explícitamente que el error no traía descripción. Un `err` vacío
 * en el log se lee como «no hubo error», que es exactamente lo contrario de lo
 * que pasó.
 */
export function descripcionDeError(error: unknown): string {
  if (typeof error === "string") return error.trim() === "" ? sinDescripcion(error) : error;

  if (error instanceof Error) {
    const propio = error.message.trim() === "" ? error.name : error.message;
    // `cause` es donde `fetch` deja el motivo real: sin esto, un problema de
    // red se lee siempre como el genérico "fetch failed".
    const causa = "cause" in error && error.cause != null ? descripcionDeError(error.cause) : "";
    return causa === "" || propio.includes(causa) ? propio : `${propio} — ${causa}`;
  }

  if (typeof error === "object" && error !== null) {
    const objeto = error as Record<string, unknown>;
    const partes = CAMPOS_DE_POSTGREST.map((campo) => objeto[campo])
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map((v) => String(v).trim())
      .filter((v) => v !== "");
    if (partes.length > 0) return partes.join(" · ");

    // Un objeto que no es de Postgrest igual tiene más adentro que
    // `[object Object]`. El `try` cubre las referencias circulares.
    try {
      const json = JSON.stringify(error);
      if (json !== undefined && json !== "{}") return json;
    } catch {
      // Cae al final.
    }
    return sinDescripcion(error);
  }

  const texto = String(error);
  return texto.trim() === "" || texto === "[object Object]" ? sinDescripcion(error) : texto;
}

function sinDescripcion(error: unknown): string {
  return `error sin descripción (${typeof error})`;
}
