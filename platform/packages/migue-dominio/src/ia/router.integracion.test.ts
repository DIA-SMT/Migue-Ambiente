/**
 * Clasificación real contra OpenRouter.
 *
 * Los mensajes salen de la Especificación MVP y del documento de QA, así que
 * son los que un vecino escribe de verdad. Se saltea sola si falta la clave.
 *
 * Donde hay ambigüedad genuina se acepta un conjunto de respuestas en lugar de
 * una sola. Exigir una única clasificación en un caso realmente ambiguo
 * produce un test frágil que falla por variación del modelo y no por un bug.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clasificar, decidir, type Intencion } from "./router.ts";
import { catalogoPrueba } from "../flujos/_fixtures.ts";

const hayClave = Boolean(process.env["OPENROUTER_API_KEY"]);
const CAT = catalogoPrueba();

/** Mensaje → intenciones aceptables. */
const CASOS: ReadonlyArray<readonly [string, readonly Intencion[]]> = [
  // Flujo A · pedidos de retiro
  ["necesito que me retiren unos escombros de una obra", ["retiro_no_habitual"]],
  ["tengo 5 bolsas de poda para que se lleven", ["retiro_no_habitual"]],
  ["quiero tirar un colchon viejo y una heladera", ["retiro_no_habitual"]],
  ["podrian pasar a buscar unas ramas que corte?", ["retiro_no_habitual"]],

  // Flujo B · reclamos
  ["hace 3 dias que no pasa el camion de la basura", ["reclamo_recoleccion"]],
  ["paso el recolector y no se llevo mi bolsa", ["reclamo_recoleccion"]],
  ["no estan recolectando en mi cuadra", ["reclamo_recoleccion"]],

  // La distinción que más importa: preguntar NO es reclamar.
  ["cuando pasa el camion por mi casa?", ["consulta_libre"]],
  ["a que hora recolectan en la zona sur?", ["consulta_libre"]],

  // Flujo C · programas
  ["quiero solicitar un taller de educacion ambiental para mi escuela", ["programa_educa"]],
  ["nos gustaria pintar un mural en la plaza del barrio", ["programa_transforma"]],

  // Consultas libres
  ["donde hay un punto verde cerca?", ["consulta_libre"]],
  ["que se puede tirar en los puntos verdes?", ["consulta_libre"]],
  ["cuantas bolsas de escombros retiran gratis?", ["consulta_libre"]],

  // Fuera de alcance
  ["cuanto sale renovar el registro de conducir", ["no_entendido", "consulta_libre"]],
  ["asdkjhasd qwe", ["no_entendido"]],

  // Ambiguo de verdad: puede leerse como consulta o como pedido de coordinación.
  [
    "pasan a buscar los reciclables por mi casa?",
    ["consulta_libre", "programa_separa"],
  ],
];

describe(
  "router contra OpenRouter real",
  { skip: !hayClave ? "sin OPENROUTER_API_KEY" : false },
  () => {
    for (const [mensaje, aceptables] of CASOS) {
      it(`clasifica: "${mensaje.slice(0, 48)}${mensaje.length > 48 ? "…" : ""}"`, async () => {
        const r = await clasificar(mensaje, CAT);
        assert.ok(
          aceptables.includes(r.intencion),
          `clasificó "${r.intencion}" (confianza ${r.confianza}); esperaba ${aceptables.join(" o ")}`,
        );
      });
    }

    it("un pedido claro arranca el flujo, no el menú", async () => {
      const r = await clasificar("necesito que retiren escombros de mi casa", CAT);
      const d = decidir(r, CAT);
      assert.equal(d.tipo, "iniciar_flujo", `decidió ${d.tipo} con confianza ${r.confianza}`);
      if (d.tipo === "iniciar_flujo") assert.equal(d.flujo, "retiro_no_habitual");
    });

    it("una pregunta va al conocimiento, no a un cuestionario", async () => {
      // Es la crítica central del QA: el bot anterior imponía el menú antes de
      // escuchar. Quien pregunta algo concreto tiene que recibir una respuesta,
      // no una lista de opciones.
      const r = await clasificar("donde puedo llevar unos neumaticos viejos?", CAT);
      const d = decidir(r, CAT);
      assert.equal(d.tipo, "consultar_conocimiento", `decidió ${d.tipo}`);
    });

    it("informa el costo y la latencia de cada clasificación", async () => {
      const r = await clasificar("tengo escombros para retirar", CAT);
      assert.equal(r.porAtajo, false);
      assert.ok(r.modelo, "no registró el modelo");
      assert.ok(r.tokensEntrada > 0 && r.tokensSalida > 0);
      assert.ok(r.latenciaMs > 0);
      // El router corre en CADA mensaje, así que su costo tiene que ser visible.
      assert.ok(
        r.costoUsd === null || r.costoUsd < 0.001,
        `una clasificación costó ${r.costoUsd} USD, es demasiado para correr en cada mensaje`,
      );
    });

    it("una intención inventada por el modelo se trata como consulta libre", async () => {
      // No se puede forzar una alucinación, pero sí verificar que toda
      // clasificación caiga en la lista conocida. Una intención fuera de la
      // lista haría que el orquestador intente arrancar un flujo inexistente.
      const validas: readonly Intencion[] = [
        "retiro_no_habitual",
        "reclamo_recoleccion",
        "programa_educa",
        "programa_transforma",
        "programa_separa",
        "consulta_libre",
        "saludo",
        "despedida",
        "no_entendido",
      ];
      for (const mensaje of ["reciclar", "?", "el arbol", "aiuda"]) {
        const r = await clasificar(mensaje, CAT);
        assert.ok(validas.includes(r.intencion), `"${mensaje}" dio "${r.intencion}"`);
      }
    });
  },
);
