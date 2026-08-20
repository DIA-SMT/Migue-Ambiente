/**
 * Plantilla de bot.
 *
 * Deliberadamente no ata el bot a ninguna libreria (Telegram, Discord,
 * WhatsApp): lo que fija es el ciclo de vida —validar env, abrir recursos,
 * registrar el cierre ordenado, arrancar— que es lo que hace que PM2 pueda
 * reiniciar y recargar sin dejar conexiones colgadas.
 *
 * Cuando definamos la libreria del bot real, se reemplaza `arrancarCliente`.
 */
import {
  createLogger,
  requireEnv,
  bool,
  int,
  installShutdownHandlers,
  onShutdown,
  startHttpServer,
} from "@bots/core";

const log = createLogger("main");

async function main() {
  // 1. Validar TODA la config antes de abrir nada. Si falta algo, el proceso
  //    muere ahora y PM2 lo deja en 'errored' — mejor que descubrirlo cuando
  //    llega el primer mensaje.
  const { BOT_TOKEN } = requireEnv(["BOT_TOKEN"]);

  const usarWebhook = bool("USE_WEBHOOK", false);
  const puerto = process.env.PORT ? int("PORT") : null;

  // `bot` ya viene en las bindings base del logger — no hace falta repetirlo
  log.info({ modo: usarWebhook ? "webhook" : "polling" }, "iniciando");

  // 2. Abrir recursos y registrar como se cierran, en el mismo lugar. Asi no
  //    se olvida ninguno cuando el bot crece.
  const cliente = await arrancarCliente({ token: BOT_TOKEN, usarWebhook });
  onShutdown("cliente-bot", () => cliente.stop());

  // 3. Health server: solo si el bot tiene puerto asignado en bots.json.
  if (puerto) {
    await startHttpServer({
      port: puerto,
      readiness: () => cliente.estaConectado(),
      routes: usarWebhook
        ? {
            "POST /webhook": async (req, res, body) => {
              await cliente.manejarUpdate(body);
              res.writeHead(200).end();
            },
          }
        : {},
    });
  }

  // 4. Recien ahora enganchamos las señales: si algo de arriba falló, queremos
  //    que el error se propague y tumbe el proceso, no que se cierre "limpio".
  installShutdownHandlers();

  log.info("bot arriba y escuchando");
}

/**
 * Sustituir por el cliente real (Telegraf, discord.js, Baileys, etc.).
 * El contrato que espera el resto del archivo: stop(), estaConectado(),
 * y manejarUpdate() si usa webhook.
 */
async function arrancarCliente({ token, usarWebhook }) {
  let vivo = true;
  const latido = setInterval(() => log.debug("latido"), 60_000);

  return {
    async stop() {
      vivo = false;
      clearInterval(latido);
      log.info("cliente detenido");
    },
    estaConectado: () => vivo,
    async manejarUpdate(update) {
      log.debug({ update }, "update recibido");
    },
  };
}

main().catch((err) => {
  // Sin captura acá, un fallo de arranque se ve como un exit silencioso en PM2
  log.fatal({ err: err.message, stack: err.stack }, "falló el arranque");
  process.exit(1);
});
