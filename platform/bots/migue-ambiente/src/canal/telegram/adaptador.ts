/**
 * Adaptador de Telegram.
 *
 * Traduce en las dos direcciones y no decide nada: quién decide es el
 * orquestador, que no sabe que Telegram existe.
 */
import { Bot, GrammyError, HttpError, type Context } from "grammy";
import { procesarMensaje, type MensajeEntrante, type Puertos } from "@migue/dominio";
import { createLogger } from "@bots/core";
import { normalizarMensaje, normalizarSeleccion } from "./normalizar.ts";
import { renderizar } from "./renderizar.ts";

const log = createLogger("telegram");

/**
 * Límite de frecuencia por usuario.
 *
 * En memoria y no en Redis, a propósito: el bot corre con `instances: 1` porque
 * el long polling de Telegram no se puede clusterizar —dos procesos leyendo el
 * mismo update lo procesarían dos veces—. Con un solo proceso, un Map alcanza
 * y evita un viaje a Redis en cada mensaje.
 */
const VENTANA_MS = 60_000;
const MAX_POR_VENTANA = 20;

interface Cubeta {
  cuenta: number;
  desde: number;
}

const cubetas = new Map<string, Cubeta>();

function excedeLimite(usuario: string): boolean {
  const ahora = Date.now();
  const cubeta = cubetas.get(usuario);

  if (cubeta === undefined || ahora - cubeta.desde > VENTANA_MS) {
    cubetas.set(usuario, { cuenta: 1, desde: ahora });
    return false;
  }

  cubeta.cuenta++;
  return cubeta.cuenta > MAX_POR_VENTANA;
}

/** Limpieza periódica: sin esto el Map crece con cada usuario que escribió una vez. */
function limpiarCubetas(): void {
  const ahora = Date.now();
  for (const [usuario, cubeta] of cubetas) {
    if (ahora - cubeta.desde > VENTANA_MS * 2) cubetas.delete(usuario);
  }
}

export interface OpcionesAdaptador {
  readonly token: string;
  readonly puertos: Puertos;
}

export function crearBot(opciones: OpcionesAdaptador): Bot {
  const bot = new Bot(opciones.token);

  // El handler sólo necesita `reply` y `replyWithChatAction`, que están en el
  // Context base. Tiparlo con el contexto estrecho de cada filtro obligaría a
  // una firma distinta por handler sin ganar nada.
  const atender = async (ctx: Context, entrante: MensajeEntrante | null): Promise<void> => {
    if (entrante === null) return;

    const usuario = entrante.canalUsuarioId;

    if (excedeLimite(usuario)) {
      log.warn({ usuario }, "límite de frecuencia excedido");
      await ctx.reply(
        "Estás enviando mensajes muy seguido. Esperá un momento y volvé a escribirme.",
      );
      return;
    }

    // El indicador de «escribiendo» importa: la cadena de conocimiento puede
    // tardar tres o cuatro segundos, y sin señal el vecino asume que el mensaje
    // no llegó y vuelve a escribir.
    await ctx.replyWithChatAction("typing").catch(() => undefined);

    const inicio = Date.now();
    try {
      const resultado = await procesarMensaje(entrante, opciones.puertos);

      // Los botones del mensaje tocado ya no sirven: se los quita ANTES de
      // contestar, así el vecino ve que su toque quedó tomado sin esperar el
      // mensaje siguiente.
      //
      // Telegram deja los teclados vivos para siempre, y con la encuesta eso se
      // notaba: se votaba y se podía seguir tocando 👍 👎 👍 indefinidamente. La
      // base ya bloquea el segundo voto (029), pero sin quitar el teclado el
      // vecino no tiene forma de saberlo — toca, no pasa nada, y parece roto.
      //
      // Quién decide es el dominio (`quitarBotones`); acá sólo se ejecuta. Y se
      // ignora el fallo: si el mensaje es viejo, si ya no tiene teclado, o si
      // Telegram dice «message is not modified», nada de eso es un problema del
      // vecino. `editMessageReplyMarkup` sólo tiene sentido sobre el mensaje de
      // un callback, así que se comprueba que haya uno.
      if (resultado.quitarBotones && ctx.callbackQuery !== undefined) {
        await ctx.editMessageReplyMarkup().catch(() => undefined);
      }

      for (const saliente of resultado.salientes) {
        for (const envio of renderizar(saliente)) {
          await ctx.reply(envio.texto, {
            ...(envio.teclado ? { reply_markup: envio.teclado } : {}),
            link_preview_options: { is_disabled: true },
          });
        }
      }

      log.info(
        {
          usuario,
          origen: resultado.origenRespuesta,
          flujo: resultado.flujoActivo,
          mensajes: resultado.salientes.length,
          ms: Date.now() - inicio,
        },
        "atendido",
      );
    } catch (error) {
      // Un fallo interno no puede dejar al vecino sin ninguna respuesta: el
      // silencio es indistinguible de un bot roto, y no le da ninguna
      // alternativa.
      log.error(
        { usuario, err: error instanceof Error ? error.message : String(error) },
        "falló al atender",
      );
      await ctx
        .reply(
          "Tuve un problema para procesar tu mensaje. Probá de nuevo en un momento, " +
            "o escribí a la Dirección de Ambiente si es urgente.",
        )
        .catch(() => undefined);
    }
  };

  // -------------------------------------------------------------------------
  // Mensajes
  // -------------------------------------------------------------------------
  bot.on("message", async (ctx) => {
    await atender(ctx, normalizarMensaje(ctx.message));
  });

  // -------------------------------------------------------------------------
  // Botones
  // -------------------------------------------------------------------------
  bot.on("callback_query:data", async (ctx) => {
    // Se responde primero para cortar el reloj de carga del botón. Si se
    // esperara a procesar, el vecino ve el botón girando varios segundos y
    // vuelve a tocarlo.
    await ctx.answerCallbackQuery().catch(() => undefined);
    await atender(ctx, normalizarSeleccion(ctx.callbackQuery));
  });

  // -------------------------------------------------------------------------
  // Errores del transporte
  // -------------------------------------------------------------------------
  bot.catch((error) => {
    const causa = error.error;
    if (causa instanceof GrammyError) {
      log.error({ descripcion: causa.description, metodo: causa.method }, "error de la API de Telegram");
    } else if (causa instanceof HttpError) {
      log.error({ err: String(causa) }, "no pude contactar a Telegram");
    } else {
      log.error({ err: causa instanceof Error ? causa.message : String(causa) }, "error no manejado");
    }
  });

  const limpieza = setInterval(limpiarCubetas, VENTANA_MS);
  limpieza.unref();

  return bot;
}
