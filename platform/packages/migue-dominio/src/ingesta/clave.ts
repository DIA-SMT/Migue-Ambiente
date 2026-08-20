/**
 * Nombre del archivo dentro del bucket de Storage.
 *
 * Supabase rechaza las claves con caracteres no ASCII y con buena parte de la
 * puntuación: devuelve «Invalid key» y nada más. Se descubrió subiendo el corpus
 * real, donde dos de ocho archivos fallaron —«Documento sin título.docx» por la
 * tilde y el workflow de reclamos por tener 200 caracteres de nombre—.
 *
 * Esto vive en el dominio y no en el script de carga porque el panel va a subir
 * archivos con los nombres que le den los administradores: «Ordenanza N° 4.512
 * — Residuos.pdf» es exactamente el caso que va a llegar.
 */

/**
 * Largo máximo de la clave.
 *
 * Supabase admite claves largas, pero un nombre de 200 caracteres es ilegible
 * en el panel de Storage y no aporta nada: el título legible vive en
 * `documentos.titulo`, y la clave sólo tiene que ser única y reconocible.
 */
const LARGO_MAXIMO = 90;

/**
 * Pasa un texto a ASCII seguro para una clave de Storage.
 *
 * Se descomponen los acentos y se sacan las marcas, igual que hace `normalizar`
 * para la búsqueda, pero acá el objetivo es distinto: no perder el parecido con
 * el nombre original para que alguien pueda reconocer el archivo mirando el
 * bucket.
 */
function aAsciiSeguro(texto: string): string {
  return (
    texto
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      // La ñ sin su tilde queda como n, que es lo que se busca. Lo que no tiene
      // equivalente ASCII —comillas tipográficas, rayas, símbolos— pasa a guion.
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
  );
}

/**
 * Arma la clave de Storage de un documento.
 *
 * Lleva el prefijo del hash para que dos archivos distintos con el mismo nombre
 * no se pisen, y conserva el nombre saneado para que el bucket se pueda leer a
 * ojo. La extensión se preserva siempre: es lo que usa el worker para elegir el
 * extractor si la columna `formato` viniera mal.
 */
export function claveDeStorage(nombreArchivo: string, hash: string): string {
  const punto = nombreArchivo.lastIndexOf(".");
  const conExtension = punto > 0;
  const base = conExtension ? nombreArchivo.slice(0, punto) : nombreArchivo;
  const extension = conExtension ? aAsciiSeguro(nombreArchivo.slice(punto + 1)).toLowerCase() : "";

  const prefijo = `${hash.slice(0, 8)}-`;
  const sufijo = extension === "" ? "" : `.${extension}`;
  const disponible = LARGO_MAXIMO - prefijo.length - sufijo.length;

  let cuerpo = aAsciiSeguro(base).slice(0, Math.max(1, disponible));
  // Recortar puede dejar un guion colgando al final.
  cuerpo = cuerpo.replace(/[-.]+$/g, "");
  // Un nombre que era todo acentos y puntuación puede quedar vacío.
  if (cuerpo === "") cuerpo = "documento";

  return `${prefijo}${cuerpo}${sufijo}`;
}
