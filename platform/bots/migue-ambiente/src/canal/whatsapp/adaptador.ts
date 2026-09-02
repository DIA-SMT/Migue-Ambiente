/**
 * Adaptador de WhatsApp.
 *
 * El espejo de telegram/adaptador.ts: traduce en las dos direcciones y no
 * decide nada — quién decide es el orquestador, que no sabe que WhatsApp
 * existe. La diferencia de transporte: acá los mensajes llegan por el webhook
 * (Meta nos hace POST) y las respuestas salen por la Graph API.
 *
 * El bucle es el mismo, a propósito: límite de frecuencia → señal de «leído y
 * escribiendo» → procesarMensaje → renderizar y enviar EN ORDEN → log con las
 * mismas claves que Telegram, para que el monitoreo no distinga canales.
 */
import { procesarMensaje, descripcionDeError, type Puertos } from "@migue/dominio";
import { createLogger } from "@bots/core";
import type { Entrega } from "./webhook.ts";
import { normalizarMensaje } from "./normalizar.ts";
import { renderizar } from "./renderizar.ts";
import {
  enviarMensaje,
  marcarLeidoYEscribiendo,
  trazaDeError,
  type ConfigWhatsApp,
} from "./cliente.ts";
import { crearLimiteDeFrecuencia } from "../limite.ts";
import { AVISO_FRECUENCIA, DISCULPA_ERROR } from "../comun.ts";

const log = createLogger("whatsapp");

export interface OpcionesAdaptadorWhatsApp {
  readonly config: ConfigWhatsApp;
  readonly puertos: Puertos;
  /** Inyectables para las pruebas; por defecto, los reales (patrón vision.ts). */
  readonly enviar?: typeof enviarMensaje;
  readonly marcarLeido?: typeof marcarLeidoYEscribiendo;
  readonly procesar?: typeof procesarMensaje;
}

export interface AdaptadorWhatsApp {
  /** Se enchufa en rutasDelWebhook({ alLlegar }). */
  readonly alLlegar: (entrega: Entrega, cuerpo: unknown) => Promise<void>;
  /** Corta el interval del límite de frecuencia. */
  readonly detener: () => void;
}

export function crearAdaptadorWhatsApp(opciones: OpcionesAdaptadorWhatsApp): AdaptadorWhatsApp {
  const enviar = opciones.enviar ?? enviarMensaje;
  const marcarLeido = opciones.marcarLeido ?? marcarLeidoYEscribiendo;
  const procesar = opciones.procesar ?? procesarMensaje;
  const { config, puertos } = opciones;

  // Instancia propia del canal: la cubeta de Telegram es otra.
  const limite = crearLimiteDeFrecuencia();

  // Best-effort SIEMPRE: ni el aviso de frecuencia ni la disculpa pueden
  // lanzar — esto corre a espaldas de Meta, después del 200.
  async function decirle(destinatario: string, texto: string): Promise<void> {
    await enviar(config, destinatario, { tipo: "texto", texto }).catch((error) =>
      log.warn(trazaDeError(error), "no pude mandar el aviso"),
    );
  }

  async function alLlegar(entrega: Entrega): Promise<void> {
    // Secuencial: el orden del sobre se respeta, igual que Telegram procesa
    // sus updates de a uno.
    for (const crudo of entrega.mensajes) {
      const entrante = normalizarMensaje(crudo);
      if (entrante === null) {
        // Un gesto (reaction, sticker) o un aviso de sistema: sin turno.
        log.debug({ tipo: crudo.tipo }, "mensaje sin turno");
        continue;
      }

      const usuario = entrante.canalUsuarioId;

      if (limite.excede(usuario)) {
        log.warn({ usuario }, "límite de frecuencia excedido");
        await decirle(usuario, AVISO_FRECUENCIA);
        continue;
      }

      // Leído + «escribiendo…» en una sola llamada: el equivalente del
      // replyWithChatAction de Telegram. Jamás bloquea una respuesta.
      await marcarLeido(config, crudo.id).catch(() => undefined);

      const inicio = Date.now();
      try {
        const resultado = await procesar(entrante, puertos);

        if (resultado.duplicado === true) {
          // La primera entrega ya contestó; esto era un reintento de Meta.
          log.info({ usuario, wamid: crudo.id }, "reintento de Meta descartado");
          continue;
        }

        // `quitarBotones` se ignora A PROPÓSITO: WhatsApp no puede editar un
        // mensaje ya enviado. El bloqueo del segundo voto lo hace la base
        // (029); el razonamiento completo está en orquestador.ts, en el
        // comentario de `quitarBotones`.

        // Un envío caído corta TODOS los envíos que quedaban de este turno:
        // mandar el «¿te sirvió?» detrás de una respuesta que no salió, o la
        // segunda mitad sin la primera, confunde más que callar. El resto de
        // la entrega (otros vecinos en el mismo sobre) sigue.
        turno: for (const saliente of resultado.salientes) {
          for (const envio of renderizar(saliente)) {
            try {
              await enviar(config, usuario, envio);
            } catch (error) {
              log.error(trazaDeError(error), "falló un envío a WhatsApp");
              break turno;
            }
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
        // silencio es indistinguible de un bot roto.
        log.error({ usuario, err: descripcionDeError(error) }, "falló al atender");
        await decirle(usuario, DISCULPA_ERROR);
      }
    }
  }

  return {
    alLlegar,
    // El apagado lo registra quien arma el proceso (index.ts), no la fábrica:
    // las pruebas crean adaptadores y no deben colgar handlers globales.
    detener: () => limite.detener(),
  };
}
