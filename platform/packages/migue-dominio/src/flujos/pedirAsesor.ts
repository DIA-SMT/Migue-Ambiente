/**
 * FLUJO · Pedido de asesor humano
 *
 * El vecino pidió hablar con una persona. El flujo hace UNA sola cosa: pedirle
 * un teléfono y registrar la alerta que el panel muestra hasta que alguien lo
 * llama. El teléfono se pide porque en Telegram no hay ningún otro dato de
 * contacto —el username no se captura y el número no existe—, así que una
 * alerta sin teléfono obliga al área a contestar por el propio bot.
 *
 * Darlo es optativo. Con «no» (o cualquier negativa) la alerta se crea igual,
 * sin número, y se le avisa que la respuesta va a llegar por acá. La alerta se
 * crea SIEMPRE que el paso cierre: un vecino que pidió una persona y no
 * entendió la pregunta del teléfono sigue siendo un vecino esperando.
 *
 * LÍMITE CONOCIDO: si la respuesta es «nada» o «no quiero», `quiereSalir()`
 * del motor la lee como cancelación y corta el flujo ANTES de que este paso la
 * vea — en ese caso la alerta no se crea. Se acepta: la cancelación explícita
 * gana siempre, y «no» / «no tengo» sí llegan hasta acá.
 */
import { extraerTelefono } from "./programas.ts";
import { leerTexto } from "../datos/catalogo.ts";
import { interpolar, normalizar, recortar } from "../texto.ts";
import { decir, textoEfectivo } from "../mensajeria.ts";
import type { DatosFlujo, DefinicionFlujo, Transicion } from "./tipos.ts";

interface DatosAsesor extends DatosFlujo {
  /** El mensaje con que pidió el asesor. Llega por datosIniciales. */
  readonly motivo?: string;
  /** Ya se le repreguntó el teléfono una vez. */
  readonly reintentado?: boolean;
}

function leer(datos: DatosFlujo): DatosAsesor {
  return datos as DatosAsesor;
}

/**
 * «No quiere darlo», dicho de las formas en que se dice.
 *
 * Anclada al texto completo normalizado, no por contiene: «no encuentro el
 * número ahora, esperá» no es una negativa, es un pedido de paciencia.
 */
function esNegativa(texto: string): boolean {
  return /^(no|nop|no tengo|no quiero|no gracias|prefiero (que )?no( darlo)?|sin telefono|no lo doy|mejor no)$/.test(
    normalizar(texto).trim(),
  );
}

/** El motivo acumulado: lo que pidió al principio más lo que agregó después. */
function acumularMotivo(previo: string | undefined, textoTurno: string): string | null {
  const junto = [previo, textoTurno].filter(Boolean).join(" · ");
  return junto === "" ? null : recortar(junto, 500);
}

export const flujoPedirAsesor: DefinicionFlujo = {
  nombre: "pedir_asesor",
  pasoInicial: "telefono",

  pasos: {
    telefono: {
      abrir: (ctx) => [decir(leerTexto(ctx.catalogo, "asesor_pedir_telefono"), "texto")],
      // El paso cierra solo al segundo intento fallido (abajo), así que este
      // techo es una red por si esa lógica cambiara: el mensaje de intentos
      // agotados del motor diría «dejo el pedido sin registrar», y acá sería
      // mentira — la alerta se registra igual.
      maxIntentos: 3,

      procesar: (ctx, datos, entrante): Transicion => {
        const previo = leer(datos);
        const texto = textoEfectivo(entrante);
        const telefono = extraerTelefono(texto);

        if (telefono !== null) {
          return {
            tipo: "terminar",
            mensajes: [
              decir(
                interpolar(leerTexto(ctx.catalogo, "asesor_confirmacion"), { telefono }),
                "nada",
              ),
            ],
            efectos: [
              {
                tipo: "crear_alerta_asesor",
                datos: { telefono, motivo: previo.motivo ?? null },
              },
            ],
          };
        }

        // Lo que escribió no es un teléfono: puede ser la negativa, o más
        // contexto de su problema («es por una rama que nadie retira»). Lo
        // segundo se suma al motivo — es exactamente lo que el área quiere
        // leer antes de llamar.
        if (!esNegativa(texto) && previo.reintentado !== true) {
          return {
            tipo: "repetir",
            datos: { motivo: acumularMotivo(previo.motivo, texto), reintentado: true },
            mensaje: decir(leerTexto(ctx.catalogo, "asesor_reintento_telefono"), "texto"),
          };
        }

        // Negativa, o segundo mensaje sin teléfono: la alerta sale igual.
        const motivo = esNegativa(texto)
          ? (previo.motivo ?? null)
          : acumularMotivo(previo.motivo, texto);
        return {
          tipo: "terminar",
          mensajes: [decir(leerTexto(ctx.catalogo, "asesor_sin_telefono"), "nada")],
          efectos: [{ tipo: "crear_alerta_asesor", datos: { telefono: null, motivo } }],
        };
      },
    },
  },
};
