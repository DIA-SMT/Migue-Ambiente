/**
 * @bots/core — base compartida por todos los bots de la VPS.
 *
 * Arranque tipico de un bot:
 *
 *   import { createLogger, requireEnv, installShutdownHandlers, onShutdown }
 *     from "@bots/core";
 *
 *   const log = createLogger("main");
 *   const { BOT_TOKEN } = requireEnv(["BOT_TOKEN"]);   // falla al arrancar
 *
 *   const cliente = crearCliente(BOT_TOKEN);
 *   onShutdown("cliente", () => cliente.stop());
 *   installShutdownHandlers();
 *
 *   await cliente.start();
 *   log.info("bot arriba");
 */

export { createLogger, logger } from "./logger.js";
export {
  str,
  int,
  bool,
  list,
  requireEnv,
  MissingEnvError,
  NODE_ENV,
  IS_PROD,
  BOT_NAME,
} from "./env.js";
export { onShutdown, shutdown, installShutdownHandlers } from "./shutdown.js";
export { getRedis, createRedisSubscriber } from "./redis.js";
export { getDb, query, transaction, pingDb } from "./db.js";
export { startHttpServer } from "./http.js";
