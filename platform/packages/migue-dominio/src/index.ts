/**
 * @migue/dominio — lógica de negocio de Migue Ambiente.
 *
 * Este paquete NO conoce ningún canal: no importa grammY, ni Telegram, ni
 * WhatsApp. Eso es lo que permitirá agregar WhatsApp más adelante escribiendo
 * sólo un adaptador, sin tocar reglas ni flujos.
 *
 * Tampoco decide textos: cada mensaje al vecino sale de la tabla `textos_bot`,
 * editable desde el panel.
 */
export { normalizar, contienePalabra, primerTerminoPresente, recortar, escaparRegex } from "./texto.ts";
export * from "./reglas/index.ts";
export * from "./datos/index.ts";
