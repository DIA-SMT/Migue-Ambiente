/**
 * Acceso a variables de entorno con validacion temprana.
 *
 * El .env de cada bot lo carga Node nativo via `--env-file=.env` (lo pone
 * ecosystem.config.cjs). Este modulo no lee archivos: solo valida y castea,
 * asi no hay dependencias extra ni sorpresas de orden de carga.
 *
 * La idea es fallar al arrancar, no en el primer mensaje que llega.
 */

class MissingEnvError extends Error {
  constructor(keys) {
    super(
      `Faltan variables de entorno obligatorias: ${keys.join(", ")}.\n` +
        `Definilas en el .env del bot (bots/<bot>/.env).`,
    );
    this.name = "MissingEnvError";
    this.keys = keys;
  }
}

function raw(key) {
  const value = process.env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Devuelve el string, o `fallback`. Tira si no hay valor ni fallback. */
export function str(key, fallback) {
  const value = raw(key);
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new MissingEnvError([key]);
}

/** Entero. Tira si el valor existe pero no es un numero valido. */
export function int(key, fallback) {
  const value = raw(key);
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new MissingEnvError([key]);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`${key} tiene que ser un entero, llegó "${value}"`);
  }
  return parsed;
}

/** Booleano: true/1/yes/on == true (case-insensitive). */
export function bool(key, fallback = false) {
  const value = raw(key);
  if (value === undefined) return fallback;
  return ["true", "1", "yes", "on", "si"].includes(value.toLowerCase());
}

/** Lista separada por comas, sin elementos vacios. */
export function list(key, fallback = []) {
  const value = raw(key);
  if (value === undefined) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Chequea de una todas las claves obligatorias y reporta TODAS las que
 * faltan juntas, en vez de una por corrida.
 *
 *   requireEnv(["BOT_TOKEN", "DATABASE_URL"]);
 */
export function requireEnv(keys) {
  const missing = keys.filter((key) => raw(key) === undefined);
  if (missing.length > 0) throw new MissingEnvError(missing);
  const result = {};
  for (const key of keys) result[key] = raw(key);
  return result;
}

export const NODE_ENV = process.env.NODE_ENV || "development";
export const IS_PROD = NODE_ENV === "production";
export const BOT_NAME = process.env.BOT_NAME || "unknown";

export { MissingEnvError };
