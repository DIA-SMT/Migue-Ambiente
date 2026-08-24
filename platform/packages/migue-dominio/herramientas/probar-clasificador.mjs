/**
 * Corre el clasificador real contra frases concretas.
 *
 * Sirve para diagnosticar por qué el bot mandó al menú algo que parecía claro:
 * muestra la intención, la confianza y si superó el umbral que decide arrancar
 * un flujo.
 *
 *   node --env-file=../../../.env.local herramientas/probar-clasificador.mjs
 *   node --env-file=../../../.env.local herramientas/probar-clasificador.mjs "mi frase"
 */
import { clasificar } from "../src/ia/router.ts";
import { obtenerCatalogo } from "../src/datos/catalogo.ts";
import { leerConfig } from "../src/datos/catalogo.ts";

const catalogo = await obtenerCatalogo();
const umbralFlujo = Number(leerConfig(catalogo, "umbral_confianza_router", 0.6));
const umbralGeneral = Number(leerConfig(catalogo, "umbral_confianza", 0.55));
const responderAntes = leerConfig(catalogo, "responder_antes_de_preguntar", true) === true;

console.log(`umbral para arrancar un flujo : ${umbralFlujo}`);
console.log(`umbral general                : ${umbralGeneral}`);
console.log(`responder antes de preguntar  : ${responderAntes}`);
console.log(`modelo del router             : ${leerConfig(catalogo, "modelo_router", "?")}`);
console.log();

const FRASES = process.argv[2]
  ? [process.argv[2]]
  : [
      // La que falló en la prueba real por Telegram.
      "Y ahora quiero hacer un reclamo",
      "quiero hacer un reclamo",
      "el camión no pasó",
      "hace tres días que no pasan a llevar la basura",
      "necesito que retiren escombros",
      "quiero un taller para mi escuela",
      "dónde llevo los neumáticos",
      "cuándo pasa el camión por mi casa",
      "hola",
      "gracias",
      "asdkjhasd",
    ];

console.log("intención             conf.  atajo  ¿arranca flujo?  frase");
console.log("-".repeat(92));

for (const frase of FRASES) {
  const c = await clasificar(frase, catalogo);
  const esFlujo = !["consulta_libre", "saludo", "despedida", "no_entendido"].includes(c.intencion);
  const arranca = esFlujo && c.confianza >= umbralFlujo;

  console.log(
    c.intencion.padEnd(22) +
      c.confianza.toFixed(2).padStart(5) +
      (c.porAtajo ? "   sí " : "   no ") +
      (esFlujo ? (arranca ? "  SÍ            " : "  no, va al menú") : "  n/c           ") +
      "  " +
      frase,
  );
}
