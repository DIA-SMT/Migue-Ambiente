/**
 * Motor de exclusiones y derivaciones.
 *
 * Es lo PRIMERO que se evalúa en cada mensaje, antes de cualquier flujo. Si el
 * vecino reporta olor a gas, no corresponde preguntarle cuántas bolsas tiene:
 * corresponde decirle que se aleje y llame a la distribuidora.
 *
 * Las reglas viven en la tabla `reglas_exclusion` y las edita un operador
 * desde el panel. Este módulo sólo las evalúa; no sabe de dónde vienen.
 */
import { contienePalabra, normalizar } from "../texto.ts";

export type AccionExclusion = "derivar" | "advertir";

export interface ReglaExclusion {
  readonly id: string;
  readonly nombre: string;
  readonly palabras: readonly string[];
  readonly organismo: string | null;
  readonly respuesta: string;
  readonly accion: AccionExclusion;
  readonly prioridad: number;
  readonly activa: boolean;
}

export interface CoincidenciaExclusion {
  readonly regla: ReglaExclusion;
  /** Qué palabra concreta disparó la regla. Va al log para poder auditar. */
  readonly palabra: string;
}

/**
 * Evalúa las reglas contra el texto y devuelve la de mayor precedencia que
 * coincida, o null.
 *
 * Precedencia por `prioridad` ascendente (menor gana), y a igualdad se
 * desempata por nombre para que el resultado sea determinista. Sin ese
 * desempate, dos reglas con la misma prioridad podrían resolverse distinto
 * según el orden en que Postgres devolvió las filas, y un bot que responde
 * distinto al mismo mensaje es imposible de depurar.
 *
 * El orden importa de verdad: la regla de gas tiene prioridad 10 justamente
 * para que un "se rompió el caño de gas y hay escombros" no caiga en el flujo
 * de escombros.
 */
export function evaluarExclusiones(
  texto: string,
  reglas: readonly ReglaExclusion[],
): CoincidenciaExclusion | null {
  const textoNorm = normalizar(texto);
  if (textoNorm === "") return null;

  const ordenadas = [...reglas]
    .filter((r) => r.activa)
    .sort((a, b) => a.prioridad - b.prioridad || a.nombre.localeCompare(b.nombre, "es"));

  for (const regla of ordenadas) {
    for (const palabra of regla.palabras) {
      if (contienePalabra(textoNorm, palabra)) {
        return { regla, palabra };
      }
    }
  }
  return null;
}

/**
 * Todas las reglas que coinciden, no sólo la primera.
 *
 * Sirve para el panel: si un operador ve que un mensaje dispara tres reglas a
 * la vez, probablemente tenga palabras demasiado genéricas cargadas. La regla
 * de agua tiene "agua", que aparece en muchísimas consultas ambientales
 * legítimas — este diagnóstico es la forma de detectarlo.
 */
export function evaluarTodasLasExclusiones(
  texto: string,
  reglas: readonly ReglaExclusion[],
): CoincidenciaExclusion[] {
  const textoNorm = normalizar(texto);
  if (textoNorm === "") return [];

  const coincidencias: CoincidenciaExclusion[] = [];
  for (const regla of reglas.filter((r) => r.activa)) {
    for (const palabra of regla.palabras) {
      if (contienePalabra(textoNorm, palabra)) {
        coincidencias.push({ regla, palabra });
        break;
      }
    }
  }
  return coincidencias.sort(
    (a, b) =>
      a.regla.prioridad - b.regla.prioridad ||
      a.regla.nombre.localeCompare(b.regla.nombre, "es"),
  );
}

/** ¿Esta coincidencia corta la conversación, o sólo agrega una advertencia? */
export function corta(coincidencia: CoincidenciaExclusion): boolean {
  return coincidencia.regla.accion === "derivar";
}
