/**
 * El barrido que pregunta, al final de la charla, si a Migue le salió bien.
 *
 * POR QUÉ ESTO EXISTE. Antes Migue preguntaba «¿te sirvió esta respuesta?»
 * pegado a cada respuesta. Funcionaba —el voto se registraba— pero medía lo que
 * no importa: alguien que pregunta tres cosas recibía tres encuestas, y ninguna
 * decía si se fue con el problema resuelto, que es la única pregunta que le
 * sirve al área. Ahora se pregunta una vez, cuando la charla se apagó.
 *
 * POR QUÉ VIVE EN EL BOT Y NO EN EL WORKER. El worker sabe bajar fotos, no
 * mandar mensajes: no tiene el cliente de Telegram ni el renderizador. El bot
 * ya tiene las dos cosas y ya corre un `setInterval` para limpiar las cubetas
 * de límite de frecuencia, así que sumar un barrido no agrega infraestructura.
 *
 * POR QUÉ UN BARRIDO Y NO UN TEMPORIZADOR POR CONVERSACIÓN. Un `setTimeout` por
 * charla se pierde entero si el proceso se reinicia —y PM2 lo reinicia en cada
 * deploy— así que las encuestas de esa ventana no salen nunca y nadie se
 * entera. El barrido pregunta por el estado actual de la base: si el proceso
 * estuvo caído dos minutos, al volver encuentra lo que quedó pendiente.
 * Además no hay nada que cancelar cuando el vecino vuelve a escribir: su
 * conversación deja de estar en silencio y se cae sola de la lista.
 */
import { createLogger } from "@bots/core";
import {
  conversacionesParaEncuestar,
  descripcionDeError,
  encuestaDeCierreEncendida,
  leerConfig,
  marcarEncuestaEnviada,
  obtenerCatalogo,
  prepararEncuestaDeCierre,
} from "@migue/dominio";
import { renderizar } from "./canal/telegram/renderizar.ts";
import type { Bot } from "grammy";

const log = createLogger("encuesta");

/**
 * Cada cuánto se mira si hay charlas apagadas.
 *
 * Treinta segundos: la mitad del minuto que es el valor por defecto del
 * silencio, así el retraso que agrega el barrido no llega a duplicar la espera
 * que configuró el área. No hace falta más fino — es una pregunta de cortesía,
 * no una alarma.
 */
const CADA_MS = 30_000;

/** Cuántas se mandan por barrido, para no ráfagear la API de Telegram. */
const POR_BARRIDO = 20;

export async function barrerEncuestas(bot: Bot): Promise<number> {
  const catalogo = await obtenerCatalogo();
  const minutos = Number(leerConfig(catalogo, "encuesta_final_minutos", 1));

  // Vaciar el texto desde el panel apaga la encuesta sin deploy, igual que las
  // otras dos. Poner los minutos en 0 hace lo mismo.
  if (!(minutos > 0) || !encuestaDeCierreEncendida(catalogo)) return 0;

  const pendientes = await conversacionesParaEncuestar(minutos, POR_BARRIDO);
  let enviadas = 0;

  for (const c of pendientes) {
    if (c.canal !== "telegram") continue;

    // El candado va ANTES del envío. Ver `marcarEncuestaEnviada`: marcando
    // después, la ventana entre mandar y marcar alcanza para que el vecino
    // reciba la pregunta dos veces.
    if (!(await marcarEncuestaEnviada(c.id))) continue;

    try {
      // QUÉ se pregunta lo arma el dominio —incluido registrar el saliente para
      // que el botón lleve pegado el id del mensaje que valora—. Acá sólo se
      // entrega.
      const pregunta = await prepararEncuestaDeCierre(c.id, catalogo);
      if (pregunta === null) continue;

      for (const envio of renderizar(pregunta)) {
        await bot.api.sendMessage(c.canalUsuarioId, envio.texto, {
          ...(envio.teclado ? { reply_markup: envio.teclado } : {}),
          link_preview_options: { is_disabled: true },
        });
      }
      enviadas += 1;
    } catch (error) {
      // Un vecino que bloqueó al bot, o un chat borrado, devuelven 403 y no se
      // arreglan reintentando. Se anota y se sigue con la próxima: una encuesta
      // que no salió no puede frenar las demás.
      log.warn({ conversacion: c.id, err: descripcionDeError(error) }, "no pude mandar la encuesta");
    }
  }

  if (enviadas > 0) log.info({ enviadas }, "encuestas de cierre enviadas");
  return enviadas;
}

/** Arranca el barrido periódico. Devuelve cómo detenerlo. */
export function arrancarEncuestas(bot: Bot): () => void {
  const t = setInterval(() => {
    // El barrido no puede tumbar el bot: si la base no responde, se anota y se
    // reintenta en treinta segundos.
    barrerEncuestas(bot).catch((error) => {
      log.warn({ err: descripcionDeError(error) }, "falló el barrido de encuestas");
    });
  }, CADA_MS);

  // Sin esto, el proceso no puede terminar hasta el próximo tic.
  t.unref?.();
  return () => clearInterval(t);
}
