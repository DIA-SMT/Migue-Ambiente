import pg from "pg";
import { createLogger } from "./logger.js";
import { onShutdown } from "./shutdown.js";
import { str } from "./env.js";

const log = createLogger("db");

let pool = null;

/**
 * Pool de Postgres compartido, creado a demanda.
 *
 * La VPS corre un solo Postgres para todos los bots. El pool es chico a
 * proposito: con varios bots en la misma maquina, muchas conexiones por bot
 * agotan `max_connections` del servidor mucho antes de hacer falta.
 */
export function getDb() {
  if (pool) return pool;

  const connectionString = str("DATABASE_URL");

  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: process.env.BOT_NAME || "bot",
  });

  // El pool sobrevive a los errores de conexiones individuales, pero si no
  // escuchamos 'error' un cliente idle que se cae tumba el proceso.
  pool.on("error", (err) => {
    log.error({ err: err.message }, "error en cliente idle del pool");
  });

  onShutdown("postgres", async () => {
    await pool.end();
    pool = null;
  });

  return pool;
}

/** Atajo para consultas de una sola vez. */
export async function query(text, params) {
  const started = process.hrtime.bigint();
  try {
    const result = await getDb().query(text, params);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > 500) log.warn({ ms: Math.round(ms), text }, "consulta lenta");
    return result;
  } catch (err) {
    log.error({ err: err.message, text }, "la consulta falló");
    throw err;
  }
}

/**
 * Corre `fn` dentro de una transaccion, con commit/rollback automatico.
 * Usa un unico cliente, que es lo que hace que la transaccion sea valida.
 */
export async function transaction(fn) {
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Chequeo de salud para el endpoint /readyz. */
export async function pingDb() {
  const { rows } = await getDb().query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}
