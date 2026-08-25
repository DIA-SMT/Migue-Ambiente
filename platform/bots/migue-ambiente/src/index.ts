/**
 * Arranque del bot Migue Ambiente.
 *
 * Este archivo hace tres cosas y ninguna más: valida la configuración, cablea
 * las dependencias reales al orquestador, y arranca el canal. Nada de lógica de
 * negocio vive acá.
 */
import {
  createLogger,
  getRedis,
  installShutdownHandlers,
  onShutdown,
  requireEnv,
} from "@bots/core";
import {
  actualizarFlujo,
  almacenRedis,
  aplicarEfectos,
  cerrarConversacion,
  clasificar,
  obtenerCatalogo,
  obtenerOAbrirConversacion,
  registrarEntrante,
  registrarSaliente,
  registrarSinRespuesta,
  registrarVoto,
  comentarVoto,
  responderConsulta,
  verificarConexion,
  type Persistencia,
  type Puertos,
} from "@migue/dominio";
import { crearBot } from "./canal/telegram/adaptador.ts";

const log = createLogger("main");

async function main(): Promise<void> {
  // Toda la configuración se valida al arrancar y se reportan TODAS las
  // faltantes juntas. Descubrir que falta una clave cuando ya hay un vecino
  // esperando es peor que no arrancar.
  const env = requireEnv([
    "TELEGRAM_BOT_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENROUTER_API_KEY",
  ]);

  // Se verifica la conexión ANTES de escuchar mensajes. Un bot que responde
  // «tuve un problema» a todo el mundo es peor que un bot que no arrancó: el
  // segundo se ve en el monitoreo, el primero parece funcionar.
  if (!(await verificarConexion())) {
    throw new Error("no pude conectarme a Supabase; reviso credenciales y salgo");
  }
  log.info("Supabase responde");

  // El catálogo se precarga para que el primer vecino no pague la latencia de
  // seis consultas.
  const catalogo = await obtenerCatalogo();
  log.info(
    {
      textos: catalogo.textos.size,
      reglas: catalogo.reglasExclusion.length,
      limites: catalogo.limitesVolumen.length,
      puntosVerdes: catalogo.puntosVerdes.length,
      respuestasFijas: catalogo.respuestasFijas.length,
    },
    "catálogo cargado",
  );

  const persistencia: Persistencia = {
    async abrirConversacion(entrante) {
      const conv = await obtenerOAbrirConversacion(entrante);
      return { id: conv.id, esNueva: conv.esNueva };
    },
    registrarEntrante: (id, entrante) => registrarEntrante(id, entrante),
    // El id del saliente SÍ se usa: el orquestador se lo pega a los botones de
    // voto para que un pulgar diga qué respuesta está valorando. Acá se
    // descartaba, y con él se descartaba la única forma de saberlo sin adivinar
    // — la base terminaba colgando todos los votos de la pregunta de cortesía.
    registrarSaliente,
    actualizarFlujo,
    cerrarConversacion,
    aplicarEfectos,
    registrarSinRespuesta,
    registrarVoto,
    comentarVoto,
  };

  const puertos: Puertos = {
    almacen: almacenRedis(getRedis()),
    obtenerCatalogo,
    clasificar,
    responder: responderConsulta,
    persistencia,
    ahora: () => new Date(),
  };

  const bot = crearBot({ token: env.TELEGRAM_BOT_TOKEN, puertos });

  const yo = await bot.api.getMe();
  log.info({ usuario: `@${yo.username}`, id: yo.id }, "bot identificado");

  // El orden importa: primero se registra cómo cerrar, después se abre. Si se
  // abriera antes, un fallo entre las dos líneas dejaría el polling activo sin
  // forma de detenerlo ordenadamente.
  onShutdown("telegram", () => bot.stop());
  installShutdownHandlers();

  // `drop_pending_updates`: al reiniciar se descartan los mensajes acumulados
  // mientras el bot estuvo caído. Responder de golpe a mensajes de hace horas
  // confunde más que ayudar, y el vecino ya buscó la información por otra vía.
  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => log.info({ usuario: `@${info.username}` }, "escuchando mensajes"),
  });
}

main().catch((error) => {
  log.fatal(
    { err: error instanceof Error ? error.message : String(error) },
    "falló el arranque",
  );
  process.exit(1);
});
