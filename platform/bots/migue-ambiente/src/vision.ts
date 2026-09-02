/**
 * El implementador real del puerto `analizarFoto`.
 *
 * El dominio decide CUÁNDO mirar una foto y qué hacer con el veredicto; acá
 * vive el CÓMO de cada canal: bajar los bytes de donde corresponda y
 * pasárselos a `evaluarFoto`. La referencia es opaca y por canal — un file_id
 * de Telegram no se puede canjear en Meta ni al revés — así que el contexto
 * trae el canal y acá se elige la descarga.
 *
 * Regla heredada de `evaluarFoto` y sostenida acá: NUNCA lanza y NUNCA miente
 * «valida». Cualquier fallo —media vencida, red caída, canal sin credenciales—
 * devuelve `no_evaluada` y el trámite sigue.
 */
import {
  evaluarFoto as evaluarFotoReal,
  obtenerCatalogo as obtenerCatalogoReal,
  leerConfig,
  VEREDICTO_NO_EVALUADO,
  type Puertos,
} from "@migue/dominio";
import { createLogger } from "@bots/core";
import { descargarDeTelegram } from "./canal/telegram/descargar.ts";
import { descargarDeWhatsApp } from "./canal/whatsapp/descargar.ts";
import type { MediaDescargada } from "./canal/media.ts";

const log = createLogger("vision");

export interface CredencialesWhatsAppVision {
  readonly token: string;
  readonly versionApi?: string;
}

export function crearAnalizadorDeFotos(opciones: {
  readonly tokenTelegram: string;
  /** null = WhatsApp apagado: una foto de ese canal queda no_evaluada, con warn. */
  readonly whatsapp?: CredencialesWhatsAppVision | null;
  /** Inyectables para las pruebas; por defecto, los reales. */
  readonly descargarTelegram?: typeof descargarDeTelegram;
  readonly descargarWhatsApp?: typeof descargarDeWhatsApp;
  readonly evaluar?: typeof evaluarFotoReal;
  readonly obtenerCatalogo?: typeof obtenerCatalogoReal;
}): Puertos["analizarFoto"] {
  const descargarTelegram = opciones.descargarTelegram ?? descargarDeTelegram;
  const descargarWhatsApp = opciones.descargarWhatsApp ?? descargarDeWhatsApp;
  const evaluar = opciones.evaluar ?? evaluarFotoReal;
  const obtenerCatalogo = opciones.obtenerCatalogo ?? obtenerCatalogoReal;

  async function descargar(
    canal: string,
    referencia: string,
  ): Promise<MediaDescargada | null> {
    if (canal === "telegram") return descargarTelegram(referencia, opciones.tokenTelegram);
    if (canal === "whatsapp") {
      if (!opciones.whatsapp) {
        // Configuración a medias, no una excepción: el canal manda fotos pero
        // nadie cargó el token para bajarlas. Se avisa fuerte y no se miente.
        log.warn("llegó una foto de WhatsApp y no hay credenciales para bajarla");
        return null;
      }
      return descargarWhatsApp(referencia, {
        token: opciones.whatsapp.token,
        versionApi: opciones.whatsapp.versionApi,
      });
    }
    log.warn({ canal }, "no sé bajar fotos de este canal");
    return null;
  }

  return async (referencia, contexto) => {
    try {
      const catalogo = await obtenerCatalogo();

      // El interruptor se mira ANTES de descargar: con la visión apagada desde
      // el panel no tiene sentido bajar 500 KB para tirarlos.
      const modelo = String(
        leerConfig(catalogo, "modelo_vision", "anthropic/claude-haiku-4.5"),
      ).trim();
      if (modelo === "") return VEREDICTO_NO_EVALUADO;

      const media = await descargar(contexto.canal, referencia);
      if (media === null) return VEREDICTO_NO_EVALUADO;

      const veredicto = await evaluar(
        { datos: media.datos, mime: media.mime },
        { flujo: contexto.flujo },
        catalogo,
      );

      log.info(
        {
          canal: contexto.canal,
          flujo: contexto.flujo,
          veredicto: veredicto.veredicto,
          categoria: veredicto.categoria,
        },
        "foto evaluada",
      );
      return veredicto;
    } catch (error) {
      // Media vencida, canal caído, catálogo inaccesible: se registra y el
      // flujo sigue con «no se pudo evaluar». Una foto jamás corta un trámite.
      log.warn({ err: error, referencia }, "no pude evaluar la foto");
      return VEREDICTO_NO_EVALUADO;
    }
  };
}
