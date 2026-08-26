/**
 * La encuesta que Migue manda cuando la charla se apagó.
 *
 * QUÉ se pregunta vive acá, en el dominio; CÓMO se entrega vive en el canal.
 * Es la misma división que ya tienen los botones de voto —la decisión de
 * quitarlos es del dominio, borrarlos del chat es de Telegram— y no es
 * prolijidad: es lo que hace que sumar WhatsApp sea un adaptador y no una
 * reescritura.
 *
 * También es lo que exige la prueba `catalogo.claves.test.ts`: toda clave de
 * `textos_bot` la tiene que leer alguien del dominio. Una clave leída sólo
 * desde el bot es una que el día de mañana nadie encuentra.
 */
import { leerTexto, tieneTexto, type Catalogo } from "./datos/catalogo.ts";
import { registrarSaliente } from "./datos/conversaciones.ts";
import { opcionesDeVoto } from "./flujos/opciones.ts";
import { preguntar } from "./mensajeria.ts";
import type { MensajeSaliente } from "./mensajeria.ts";

/** La clave del texto. Suelta, para que la prueba de claves la encuentre. */
const CLAVE = "encuesta_cierre";

/** ¿Está encendida? Vaciar el texto desde el panel la apaga sin deploy. */
export function encuestaDeCierreEncendida(catalogo: Catalogo): boolean {
  return tieneTexto(catalogo, CLAVE);
}

/**
 * Arma la pregunta de cierre de una conversación, ya registrada como saliente.
 *
 * Registra ANTES de devolver porque el botón lleva pegado el id del mensaje que
 * valora: sin registrar primero no hay id, y sin id la base tendría que adivinar
 * contra qué mensaje va el voto — que es exactamente el bug que arregló la 029.
 *
 * Devuelve null si la encuesta está apagada, para que quien llame no tenga que
 * consultar el catálogo por su cuenta.
 */
export async function prepararEncuestaDeCierre(
  conversacionId: string,
  catalogo: Catalogo,
): Promise<MensajeSaliente | null> {
  if (!encuestaDeCierreEncendida(catalogo)) return null;

  const texto = leerTexto(catalogo, CLAVE);

  // Se registra sin opciones: lo que queda en la base es lo que el vecino LEE.
  // Guardar los ids de los botones ahí no agrega nada y ensuciaría la
  // transcripción del panel.
  const mensajeId = await registrarSaliente(conversacionId, preguntar(texto, []), {
    intencion: CLAVE,
    origenRespuesta: null,
  });

  return preguntar(texto, opcionesDeVoto(mensajeId));
}
