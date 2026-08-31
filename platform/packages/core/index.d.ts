/**
 * Tipos de @bots/core.
 *
 * El paquete está escrito en JavaScript y probado como tal; esta declaración
 * existe para que los bots en TypeScript lo consuman con tipos, sin reescribir
 * código que ya funciona.
 *
 * Si se agrega algo a `src/`, hay que declararlo acá. Es la desventaja de una
 * declaración a mano, y el precio de no migrar un paquete estable.
 */

// ---------------------------------------------------------------------------
// logger
// ---------------------------------------------------------------------------

export interface Logger {
  trace(objeto: unknown, mensaje?: string): void;
  trace(mensaje: string): void;
  debug(objeto: unknown, mensaje?: string): void;
  debug(mensaje: string): void;
  info(objeto: unknown, mensaje?: string): void;
  info(mensaje: string): void;
  warn(objeto: unknown, mensaje?: string): void;
  warn(mensaje: string): void;
  error(objeto: unknown, mensaje?: string): void;
  error(mensaje: string): void;
  fatal(objeto: unknown, mensaje?: string): void;
  fatal(mensaje: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(nombre?: string, bindings?: Record<string, unknown>): Logger;
export const logger: Logger;

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

export class MissingEnvError extends Error {
  readonly keys: string[];
}

export function str(clave: string, respaldo?: string): string;
export function int(clave: string, respaldo?: number): number;
export function bool(clave: string, respaldo?: boolean): boolean;
export function list(clave: string, respaldo?: string[]): string[];
export function requireEnv<K extends string>(claves: readonly K[]): Record<K, string>;

export const NODE_ENV: string;
export const IS_PROD: boolean;
export const BOT_NAME: string;

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

export function onShutdown(nombre: string, fn: () => unknown): void;
export function shutdown(razon: string, codigoSalida?: number, timeoutMs?: number): Promise<void>;
export function installShutdownHandlers(): void;

// ---------------------------------------------------------------------------
// redis
// ---------------------------------------------------------------------------

/**
 * Cliente de Redis. Se declara sólo la superficie que usamos en vez de
 * arrastrar los tipos de ioredis: el almacén de estado necesita `get`, `set` y
 * `del`, y nada más.
 */
export interface ClienteRedis {
  get(clave: string): Promise<string | null>;
  set(clave: string, valor: string, modo: "EX", segundos: number): Promise<unknown>;
  del(...claves: string[]): Promise<number>;
  quit(): Promise<unknown>;
  on(evento: string, escucha: (...args: unknown[]) => void): unknown;
}

export function getRedis(): ClienteRedis;
export function createRedisSubscriber(): ClienteRedis;

// ---------------------------------------------------------------------------
// db (Postgres local; el bot Migue usa Supabase y no esto)
// ---------------------------------------------------------------------------

export function getDb(): unknown;
export function query(texto: string, parametros?: unknown[]): Promise<{ rows: unknown[] }>;
export function transaction<T>(fn: (cliente: unknown) => Promise<T>): Promise<T>;
export function pingDb(): Promise<boolean>;

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

/**
 * `crudo` son los bytes del cuerpo tal como llegaron, antes de interpretarlos.
 * Los necesita cualquier webhook firmado: la firma se calcula sobre esos bytes
 * y volver a serializar el JSON no los reproduce.
 */
export type ManejadorHttp = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  body: unknown,
  crudo: Buffer,
) => unknown;

export interface OpcionesServidorHttp {
  /** 0 pide "el puerto que haya libre"; el real se lee de `server.address()`. */
  port: number;
  host?: string;
  routes?: Record<string, ManejadorHttp>;
  readiness?: () => boolean | Promise<boolean>;
  maxBodyBytes?: number;
}

export function startHttpServer(opciones: OpcionesServidorHttp): Promise<unknown>;
