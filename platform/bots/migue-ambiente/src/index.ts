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
  int,
  onShutdown,
  requireEnv,
  startHttpServer,
} from "@bots/core";
import {
  actualizarFlujo,
  descripcionDeError,
  almacenRedis,
  aplicarEfectos,
  cerrarConversacion,
  clasificar,
  obtenerCatalogo,
  obtenerOAbrirConversacion,
  registrarEntrante,
  registrarSaliente,
  ultimoOrigenSaliente,
  registrarSinRespuesta,
  registrarVoto,
  comentarVoto,
  responderConsulta,
  verificarConexion,
  type Persistencia,
  type Puertos,
} from "@migue/dominio";
import { crearBot } from "./canal/telegram/adaptador.ts";
import { rutasDelWebhook } from "./canal/whatsapp/webhook.ts";
import { crearAdaptadorWhatsApp } from "./canal/whatsapp/adaptador.ts";
import type { ConfigWhatsApp } from "./canal/whatsapp/cliente.ts";
import { arrancarEncuestas } from "./encuestaFinal.ts";
import { crearAnalizadorDeFotos } from "./vision.ts";

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
    ultimoOrigenSaliente,
    actualizarFlujo,
    cerrarConversacion,
    aplicarEfectos,
    registrarSinRespuesta,
    registrarVoto,
    comentarVoto,
  };

  // WhatsApp se enciende ENTERO o no se enciende. NO va en `requireEnv`:
  // mientras el alta con Meta no esté hecha, estas claves no existen y el bot
  // tiene que arrancar igual. Con las CUATRO presentes se levanta el webhook y
  // el canal responde; con algunas, se avisa fuerte — es un error de
  // configuración disfrazado de canal apagado. Ya no existe el modo «webhook
  // que sólo loguea»: sin token de envío, dar de alta el webhook haría que
  // Meta entregue mensajes que nadie puede contestar.
  const secretoWhatsApp = process.env["WHATSAPP_APP_SECRET"]?.trim() ?? "";
  const verifyWhatsApp = process.env["WHATSAPP_VERIFY_TOKEN"]?.trim() ?? "";
  const tokenWhatsApp = process.env["WHATSAPP_TOKEN"]?.trim() ?? "";
  const numeroIdWhatsApp = process.env["WHATSAPP_PHONE_NUMBER_ID"]?.trim() ?? "";
  const presentes = [secretoWhatsApp, verifyWhatsApp, tokenWhatsApp, numeroIdWhatsApp].filter(
    (v) => v !== "",
  ).length;

  const configWhatsApp: ConfigWhatsApp | null =
    presentes === 4
      ? {
          token: tokenWhatsApp,
          numeroId: numeroIdWhatsApp,
          versionApi: process.env["WHATSAPP_API_VERSION"]?.trim() || undefined,
        }
      : null;

  const puertos: Puertos = {
    almacen: almacenRedis(getRedis()),
    obtenerCatalogo,
    clasificar,
    responder: responderConsulta,
    // Visión: baja la foto del canal que corresponda y la evalúa. Se apaga
    // desde el panel vaciando `modelo_vision`; cualquier fallo degrada a
    // no_evaluada.
    analizarFoto: crearAnalizadorDeFotos({
      tokenTelegram: env.TELEGRAM_BOT_TOKEN,
      whatsapp: configWhatsApp,
    }),
    persistencia,
    ahora: () => new Date(),
  };

  const bot = crearBot({ token: env.TELEGRAM_BOT_TOKEN, puertos });

  const yo = await bot.api.getMe();
  log.info({ usuario: `@${yo.username}`, id: yo.id }, "bot identificado");

  // El webhook de WhatsApp, con su adaptador. Depende de `instances: 1` en
  // bots.json, igual que el límite de frecuencia: dos procesos peleando por el
  // 3002 y el segundo no arranca.
  if (configWhatsApp !== null) {
    const adaptador = crearAdaptadorWhatsApp({ config: configWhatsApp, puertos });
    onShutdown("whatsapp", () => adaptador.detener());

    const ruta = process.env["WHATSAPP_WEBHOOK_RUTA"]?.trim() || "/hooks/whatsapp";
    await startHttpServer({
      port: int("WHATSAPP_WEBHOOK_PUERTO", 3002),
      routes: rutasDelWebhook({
        ruta,
        tokenVerificacion: verifyWhatsApp,
        secretoApp: secretoWhatsApp,
        alLlegar: adaptador.alLlegar,
      }),
    });
    log.info({ ruta }, "webhook de WhatsApp escuchando, con adaptador");
  } else if (presentes > 0) {
    log.warn(
      "WhatsApp a medias: hacen falta WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, " +
        "WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID — las cuatro, no algunas",
    );
  } else {
    log.info("WhatsApp apagado: no hay credenciales configuradas");
  }

  // El orden importa: primero se registra cómo cerrar, después se abre. Si se
  // abriera antes, un fallo entre las dos líneas dejaría el polling activo sin
  // forma de detenerlo ordenadamente.
  // El barrido que pregunta, al final de la charla, si le sirvió. Arranca
  // ANTES de abrir el polling y se registra su cierre en el mismo orden que el
  // de Telegram, por el mismo motivo: que no quede un intervalo vivo si algo
  // falla entre medio.
  const detenerEncuestas = arrancarEncuestas(bot, configWhatsApp);
  onShutdown("encuestas", () => detenerEncuestas());

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
    { err: descripcionDeError(error) },
    "falló el arranque",
  );
  process.exit(1);
});
