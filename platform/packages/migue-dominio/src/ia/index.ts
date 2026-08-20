/** Cliente de OpenRouter y router de intención. */
export {
  chat,
  parsearJson,
  ErrorDeIA,
  type MensajeChat,
  type OpcionesChat,
  type RespuestaChat,
} from "./cliente.ts";

export {
  clasificar,
  decidir,
  flujosDelRouter,
  type Intencion,
  type Clasificacion,
  type Decision,
} from "./router.ts";
