/**
 * Lo único del dominio que también corre en el navegador.
 *
 * El panel es un Next.js: parte de su código se ejecuta del lado del cliente.
 * Este módulo existe para que pueda compartir con el bot y el worker las
 * funciones donde una divergencia sería un error silencioso, sin arrastrar el
 * resto del dominio a un bundle.
 *
 * REGLA: nada de lo que se exporte acá puede depender de un módulo de Node
 * (`node:crypto`, `node:fs`) ni de un paquete pesado (`pdfjs-dist`, `fflate`,
 * `@supabase/supabase-js`). Hay un test que verifica el grafo de imports y
 * falla si alguien lo rompe; ver compartido.test.ts.
 *
 * Por qué importa, con el caso concreto: `claveDeStorage` es un contrato entre
 * dos procesos. El panel arma la clave con la que sube el archivo a Supabase
 * Storage y el worker la usa para bajarlo. Si cada uno tuviera su copia y
 * divergieran, el panel subiría a una ruta que el worker no encuentra —sin
 * error visible— y el documento nunca se indexaría. Ya hubo un antecedente de
 * lo delicado que es armar esa clave: Storage rechazó 2 de 8 archivos del
 * corpus por acentos y por largo del nombre.
 */

export { claveDeStorage } from "./ingesta/clave.ts";

export {
  formatoDe,
  mimeDe,
  FormatoNoSoportadoError,
  type Formato,
} from "./ingesta/formato.ts";

/**
 * `interpolar` y los marcadores: el panel los necesita para previsualizar cómo
 * va a quedar un texto de `textos_bot` con {plazo}, {empresa} y compañía
 * resueltos, exactamente igual que los resuelve el bot al enviarlo.
 */
export { interpolar, recortar } from "./texto.ts";
