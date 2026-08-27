/**
 * Arranque del worker de ingesta.
 *
 * Es un proceso aparte del bot, y a propósito: extraer un PDF de 45 páginas
 * ocupa el hilo principal durante cientos de milisegundos, y si corriera en el
 * mismo proceso los mensajes de los vecinos esperarían detrás de un documento.
 *
 * No expone ningún puerto ni recibe nada de afuera: sólo consulta la cola en
 * Supabase. Eso es lo que hace que el panel en Vercel pueda pedirle trabajo sin
 * que haya que abrir un puerto en la VPS ni configurar un dominio.
 */
import { createLogger, installShutdownHandlers, onShutdown, requireEnv } from "@bots/core";
import { descripcionDeError, verificarConexion } from "@migue/dominio";
import { crearBucle } from "./bucle.ts";
import { crearCola } from "./cola.ts";
import { crearPuertos } from "./puertos.ts";

const log = createLogger("worker");

async function main(): Promise<void> {
  // El worker no necesita el token de Telegram ni la clave de OpenRouter: no
  // habla con vecinos ni usa el modelo. Pedirlas de más haría que no arranque
  // por una credencial que no usa.
  requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);

  // El token NO es obligatorio: sin él el worker indexa documentos igual. Pero
  // los trabajos de tipo `descargar_media` fallarían y se reintentarían para
  // siempre, así que se avisa fuerte al arrancar en vez de descubrirlo cuando
  // un vecino ya mandó una foto.
  if (!process.env["TELEGRAM_BOT_TOKEN"]?.trim()) {
    log.warn(
      "sin TELEGRAM_BOT_TOKEN: no voy a poder bajar las fotos que manden los vecinos",
    );
  }

  if (!(await verificarConexion())) {
    throw new Error("no pude conectarme a Supabase; reviso credenciales y salgo");
  }
  log.info("Supabase responde");

  // El nombre identifica quién tomó cada trabajo. Va el id de instancia de PM2
  // para poder distinguir dos workers en la misma máquina.
  const nombre = `worker-${process.env["NODE_APP_INSTANCE"] ?? "0"}@${process.env["HOSTNAME"] ?? "vps"}`;

  const bucle = crearBucle(crearCola(), crearPuertos(), {
    worker: nombre,
    registrar: (nivel, mensaje) => {
      if (nivel === "error") log.error(mensaje);
      else if (nivel === "aviso") log.warn(mensaje);
      else log.info(mensaje);
    },
  });

  installShutdownHandlers();
  onShutdown("bucle de la cola", async () => {
    // Se espera de verdad: `detener()` devuelve una promesa que resuelve cuando
    // el bucle salió. Si no se esperara, `process.exit` podría cortar el proceso
    // mientras se escriben los fragmentos de un documento en la base.
    log.info("apagando: espero que termine el trabajo en curso");
    await bucle.detener();
  });

  await bucle.correr();
  log.info({ ...bucle.estadisticas() }, "worker terminado");
}

main().catch((error: unknown) => {
  log.error({ err: descripcionDeError(error) }, "el worker no arrancó");
  process.exitCode = 1;
});
