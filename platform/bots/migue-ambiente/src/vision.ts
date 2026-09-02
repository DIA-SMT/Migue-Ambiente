/**
 * El implementador real del puerto `analizarFoto`.
 *
 * El dominio decide CUÁNDO mirar una foto y qué hacer con el veredicto; acá
 * vive el CÓMO de este canal: bajar los bytes de Telegram y pasárselos a
 * `evaluarFoto`. Cuando exista el adaptador de WhatsApp, cablea su propia
 * descarga — el dominio no cambia.
 *
 * Regla heredada de `evaluarFoto` y sostenida acá: NUNCA lanza y NUNCA miente
 * «valida». Cualquier fallo —media vencida, red caída, lo que sea— devuelve
 * `no_evaluada` y el trámite sigue.
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

const log = createLogger("vision");

export function crearAnalizadorDeFotos(opciones: {
  readonly token: string;
  /** Inyectables para las pruebas; por defecto, los reales. */
  readonly descargar?: typeof descargarDeTelegram;
  readonly evaluar?: typeof evaluarFotoReal;
  readonly obtenerCatalogo?: typeof obtenerCatalogoReal;
}): Puertos["analizarFoto"] {
  const descargar = opciones.descargar ?? descargarDeTelegram;
  const evaluar = opciones.evaluar ?? evaluarFotoReal;
  const obtenerCatalogo = opciones.obtenerCatalogo ?? obtenerCatalogoReal;

  return async (referencia, contexto) => {
    try {
      const catalogo = await obtenerCatalogo();

      // El interruptor se mira ANTES de descargar: con la visión apagada desde
      // el panel no tiene sentido bajar 500 KB para tirarlos.
      const modelo = String(
        leerConfig(catalogo, "modelo_vision", "anthropic/claude-haiku-4.5"),
      ).trim();
      if (modelo === "") return VEREDICTO_NO_EVALUADO;

      const media = await descargar(referencia, opciones.token);
      const veredicto = await evaluar(
        { datos: media.datos, mime: media.mime },
        contexto,
        catalogo,
      );

      log.info(
        { flujo: contexto.flujo, veredicto: veredicto.veredicto, categoria: veredicto.categoria },
        "foto evaluada",
      );
      return veredicto;
    } catch (error) {
      // Media vencida, Telegram caído, catálogo inaccesible: se registra y el
      // flujo sigue con «no se pudo evaluar». Una foto jamás corta un trámite.
      log.warn({ err: error, referencia }, "no pude evaluar la foto");
      return VEREDICTO_NO_EVALUADO;
    }
  };
}
