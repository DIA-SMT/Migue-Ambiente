import { createLogger } from "./logger.js";

const log = createLogger("shutdown");

/** @type {Array<{ name: string, fn: () => unknown }>} */
const handlers = [];
let shuttingDown = false;

/**
 * Registra algo que hay que cerrar antes de morir (conexiones, polling,
 * flush de colas). Se ejecutan en orden inverso al registro, como un stack:
 * lo ultimo que se abrio es lo primero que se cierra.
 */
export function onShutdown(name, fn) {
  if (typeof fn !== "function") {
    throw new TypeError(`onShutdown("${name}") espera una funcion`);
  }
  handlers.push({ name, fn });
}

async function runHandlers(timeoutMs) {
  const pending = [...handlers].reverse();
  for (const { name, fn } of pending) {
    try {
      await Promise.race([
        Promise.resolve(fn()),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`timeout de ${timeoutMs}ms`)),
            timeoutMs,
          ).unref(),
        ),
      ]);
      log.debug({ handler: name }, "cerrado");
    } catch (err) {
      // Un handler que falla no puede impedir que cierren los demas
      log.warn({ handler: name, err: err.message }, "falló al cerrar");
    }
  }
}

/**
 * Cierra la app de forma ordenada. PM2 manda SIGINT y espera `kill_timeout`
 * (8s en nuestro ecosystem) antes de mandar SIGKILL, asi que el presupuesto
 * total tiene que quedar por debajo de eso.
 */
export async function shutdown(reason, exitCode = 0, timeoutMs = 2500) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info({ reason }, "cerrando…");

  // Red de seguridad: si algo se cuelga igual salimos
  const hardExit = setTimeout(() => {
    log.error("el cierre ordenado se colgó, saliendo a la fuerza");
    process.exit(exitCode || 1);
  }, timeoutMs * handlers.length + 1000);
  hardExit.unref();

  await runHandlers(timeoutMs);
  clearTimeout(hardExit);

  log.info({ reason }, "cerrado limpio");
  process.exit(exitCode);
}

/**
 * Engancha las señales y los errores no manejados. Llamalo una vez, al final
 * del arranque del bot.
 */
export function installShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => void shutdown(signal, 0));
  }

  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "excepcion no capturada");
    void shutdown("uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason) => {
    log.fatal({ err: reason }, "promesa rechazada sin catch");
    void shutdown("unhandledRejection", 1);
  });

  log.debug("handlers de shutdown instalados");
}
