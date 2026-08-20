import Redis from "ioredis";
import { createLogger } from "./logger.js";
import { onShutdown } from "./shutdown.js";
import { BOT_NAME, str } from "./env.js";

const log = createLogger("redis");

let client = null;

/**
 * Cliente Redis compartido, creado la primera vez que se pide.
 *
 * Todas las claves quedan prefijadas con el nombre del bot, asi varios bots
 * comparten la misma instancia de Redis sin pisarse entre ellos.
 */
export function getRedis() {
  if (client) return client;

  const url = str("REDIS_URL", "redis://127.0.0.1:6379");

  client = new Redis(url, {
    keyPrefix: `${BOT_NAME}:`,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      log.warn({ times, delay }, "reintentando conexion a Redis");
      return delay;
    },
  });

  client.on("error", (err) => log.error({ err: err.message }, "error de Redis"));
  client.on("connect", () => log.info({ url: redactUrl(url) }, "Redis conectado"));

  onShutdown("redis", async () => {
    await client.quit();
    client = null;
  });

  return client;
}

/**
 * Cliente aparte para pub/sub o BLPOP. Necesario porque un cliente en modo
 * suscripcion no puede ejecutar comandos normales.
 */
export function createRedisSubscriber() {
  const url = str("REDIS_URL", "redis://127.0.0.1:6379");
  const sub = new Redis(url, { maxRetriesPerRequest: null });
  sub.on("error", (err) => log.error({ err: err.message }, "error del subscriber"));
  onShutdown("redis:subscriber", () => sub.quit());
  return sub;
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "redis://(no parseable)";
  }
}
