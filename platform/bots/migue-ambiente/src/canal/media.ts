/**
 * El contrato de descarga de archivos, compartido por los canales.
 *
 * Vivía adentro de Telegram; se movió acá cuando llegó WhatsApp para que el
 * worker y la visión hablen de UN solo tipo sin importar de dónde vino la foto.
 */

export interface MediaDescargada {
  readonly datos: Uint8Array;
  readonly mime: string;
  readonly nombre: string;
}

/**
 * El canal ya no tiene el archivo: referencia vencida, borrada o inválida.
 *
 * La semántica es «NO reintentar»: volver a pedir lo mismo va a fallar igual.
 * El worker la traduce a «archivo ausente» y sigue; todo lo demás se propaga
 * como error común y se reintenta.
 */
export class MediaVencidaError extends Error {
  constructor(canal: string, referencia: string, motivo: string) {
    super(`${canal} ya no tiene el archivo ${referencia.slice(0, 24)}…: ${motivo}`);
    this.name = "MediaVencidaError";
  }
}
