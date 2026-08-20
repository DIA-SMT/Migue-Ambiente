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
import { verificarConexion } from "@migue/dominio";
import { crearBucle } from "./bucle.ts";
import { crearCola } from "./cola.ts";
import { crearPuertos } from "./puertos.ts";

const log = createLogger("worker");

async function main(): Promise<void> {
  // El worker no necesita el token de Telegram ni la clave de OpenRouter: no
  // habla con vecinos ni usa el modelo. Pedirlas de más haría que no arranque
  // por una credencial que no usa.
  requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);

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
  log.error({ err: error instanceof Error ? error.message : String(error) }, "el worker no arrancó");
  process.exitCode = 1;
});
