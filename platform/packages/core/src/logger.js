import pino from "pino";

const isProd = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL || (isProd ? "info" : "debug");

// En produccion: JSON en una linea, que es lo que pm2-logrotate archiva bien.
// En desarrollo: coloreado y legible.
const base = pino({
  level,
  base: { bot: process.env.BOT_NAME || "unknown", pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "token",
      "*.token",
      "password",
      "*.password",
      "authorization",
      "*.authorization",
      "apiKey",
      "*.apiKey",
      "*.secret",
    ],
    censor: "[oculto]",
  },
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }),
});

/**
 * Logger con contexto. Usalo con el nombre del modulo:
 *   const log = createLogger("handlers:mensajes");
 */
export function createLogger(name, bindings = {}) {
  return name ? base.child({ mod: name, ...bindings }) : base;
}

export const logger = base;
