/**
 * Qué texto del bot acepta marcadores, y cuáles.
 *
 * Existe porque `interpolar()` NO se aplica a todos los textos: se llama en
 * exactamente dos lugares del código, los pasos de confirmación de los dos
 * trámites. Todas las demás claves se leen con `leerTexto()` y se envían sin
 * tocar.
 *
 * Sin esta lista el panel validaba mal, y de la peor forma posible: comprobaba
 * que el marcador estuviera en `marcadores_disponibles` —o sea que el NOMBRE
 * fuera de uno real— pero no que la clave donde se escribió llegara a
 * interpolarse. Escribir «Hola, te contesto en {plazo}» en `bienvenida` se
 * guardaba sin protestar, y el vecino recibía literalmente «te contesto en
 * {plazo}», con las llaves. Peor todavía: la vista previa del panel lo mostraba
 * resuelto, así que daba confianza para guardarlo.
 *
 * Vive en el dominio y no en el panel a propósito. Es una propiedad del CÓDIGO
 * del bot —qué paso llama a `interpolar` y con qué valores— y una copia en el
 * panel se desincronizaría en el primer paso nuevo que interpolara algo. En este
 * proyecto eso ya pasó tres veces: la lista de tipos de trabajo en `cola.ts`, el
 * fixture del catálogo, y la lista de claves que podían ir vacías en el panel.
 *
 * La prueba que lo mantiene honesto no compara contra esta lista —eso sería
 * confirmar mi propia suposición— sino que simula los flujos y verifica que
 * ningún mensaje saliente conserve un `{marcador}` sin resolver.
 */

/** Los cuatro valores que los pasos de confirmación saben resolver. */
export const MARCADORES_DE_CONFIRMACION = [
  "{plazo}",
  "{vencimiento}",
  "{empresa}",
  "{direccion}",
] as const;

/**
 * Por clave de `textos_bot`, los marcadores que el bot va a reemplazar.
 *
 * Una clave ausente significa CERO marcadores: lo que se escriba con llaves le
 * llega al vecino con las llaves.
 */
export const MARCADORES_POR_TEXTO: Readonly<Record<string, readonly string[]>> = {
  // `retiroNoHabitual.ts`, paso de confirmación.
  retiro_confirmacion: MARCADORES_DE_CONFIRMACION,
  // `reclamoRecoleccion.ts`, paso de confirmación.
  reclamo_confirmacion: MARCADORES_DE_CONFIRMACION,
};

/** Los marcadores que acepta esta clave. Vacío si no acepta ninguno. */
export function marcadoresDe(clave: string): readonly string[] {
  return MARCADORES_POR_TEXTO[clave] ?? [];
}

/**
 * Los marcadores escritos en un texto que la clave NO va a resolver.
 *
 * Es lo que el panel tiene que rechazar antes de guardar. Devuelve la lista sin
 * repetidos para poder nombrarlos en el mensaje de error.
 */
export function marcadoresQueNoSeResuelven(
  clave: string,
  texto: string,
): string[] {
  const validos = marcadoresDe(clave);
  const usados = [...texto.matchAll(/\{[a-zA-Z_]+\}/g)].map((m) => m[0]);
  return [...new Set(usados.filter((u) => !validos.includes(u)))];
}
