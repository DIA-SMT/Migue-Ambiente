/**
 * Qué texto del bot acepta marcadores, y cuáles.
 *
 * Existe porque `interpolar()` NO se aplica a todos los textos: se llama en los
 * pasos de confirmación de los dos trámites y en el aviso de lo que el reclamo
 * no pudo cargar. Todas las demás claves se leen con `leerTexto()` y se envían sin
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
  // `orquestador.ts`, rama de derivación. `{migue}` es el enlace al asistente
  // general del municipio, que sale de `configuracion.enlace_migue`.
  derivar_a_migue: ["{migue}"],
  // `reclamoRecoleccion.ts`, el aviso de lo que quedó sin cargar.
  pedido_pendientes: ["{faltante}"],
  // `retiroNoHabitual.ts`, la repregunta cuando la foto no corresponde.
  // `{detalle}` es la explicación del modelo de visión.
  retiro_foto_no_corresponde: ["{detalle}"],
};

/**
 * Los marcadores que resuelve una RESPUESTA FIJA.
 *
 * Las fijas son otra tabla y otro camino: no se leen con `leerTexto()` sino que
 * las encuentra `buscarRespuestaFija()` por disparador, y se envían textuales
 * sin pasar por el modelo. Por eso tienen su propia lista.
 *
 * Sólo entran valores que salen del CATÁLOGO, o sea de tablas que el área edita
 * desde el panel. `{plazo}` no está y no puede estar: es una fecha calculada
 * contra el momento del pedido, y una fija no tiene pedido del cual calcularla.
 *
 * Esto existe para no duplicar datos. Las tres direcciones de los Puntos Verdes
 * ya viven en la tabla `puntos_verdes`, editable en Reglas; escribirlas también
 * adentro del texto de una fija habría creado dos fuentes de verdad, y el día
 * que cambie un Punto Verde Reglas diría una cosa y el bot otra. Este proyecto
 * ya pagó ese error dos veces.
 *
 * Las FAQs NO interpolan, y la asimetría es a propósito: una fija se envía tal
 * cual y sabemos exactamente qué sale; una FAQ entra al modelo como material y
 * lo que el modelo haga con un `{marcador}` —copiarlo, parafrasearlo, ignorarlo—
 * no está bajo nuestro control.
 */
export const MARCADORES_DE_RESPUESTA_FIJA = [
  "{puntos_verdes}",
  "{plazo_habitual}",
  "{limites}",
  "{zonas}",
  "{empresa}",
] as const;

/**
 * Los marcadores escritos en una respuesta fija que el bot NO va a resolver.
 *
 * Es lo que el panel tiene que rechazar antes de guardar, igual que
 * `marcadoresQueNoSeResuelven` para los textos del bot.
 */
export function marcadoresQueNoResuelveUnaFija(texto: string): string[] {
  const usados = [...texto.matchAll(/\{[a-zA-Z_]+\}/g)].map((m) => m[0]);
  return [
    ...new Set(
      usados.filter((u) => !(MARCADORES_DE_RESPUESTA_FIJA as readonly string[]).includes(u)),
    ),
  ];
}

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
