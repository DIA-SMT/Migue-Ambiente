import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clasificar, decidir, type Clasificacion } from "./router.ts";
import { catalogoPrueba } from "../flujos/_fixtures.ts";

/**
 * Estas pruebas no llegan a la red: los saludos y despedidas se resuelven por
 * atajo, y `decidir` es una función pura. La clasificación real contra
 * OpenRouter está en router.integracion.test.ts.
 */

const CAT = catalogoPrueba();

function clasif(parcial: Partial<Clasificacion>): Clasificacion {
  return {
    intencion: "consulta_libre",
    confianza: 0.9,
    porAtajo: false,
    modelo: null,
    tokensEntrada: 0,
    tokensSalida: 0,
    costoUsd: null,
    latenciaMs: 0,
    ...parcial,
  };
}

describe("atajos sin llamar al modelo", () => {
  it("reconoce saludos", async () => {
    for (const texto of ["hola", "Hola!", "buenas", "buen dia", "Buenas tardes", "que tal"]) {
      const r = await clasificar(texto, CAT);
      assert.equal(r.intencion, "saludo", `"${texto}"`);
      assert.equal(r.porAtajo, true, "no debería llamar al modelo");
      assert.equal(r.tokensSalida, 0);
    }
  });

  it("reconoce despedidas", async () => {
    for (const texto of ["gracias", "muchas gracias", "listo gracias", "chau", "perfecto gracias"]) {
      const r = await clasificar(texto, CAT);
      assert.equal(r.intencion, "despedida", `"${texto}"`);
      assert.equal(r.porAtajo, true);
    }
  });

  it("«hola» dentro de un pedido NO es un saludo", async () => {
    // Contestarle «¡Hola!» a quien ya dijo lo que necesita y esperar es
    // exactamente el comportamiento que el documento de QA critica.
    const r = await clasificar("hola, necesito que me retiren unos escombros de una obra", CAT);
    assert.notEqual(r.intencion, "saludo");
    assert.equal(r.porAtajo, false, "un mensaje largo tiene que ir al clasificador");
  });

  it("el atajo sólo aplica a mensajes cortos", async () => {
    const r = await clasificar("buenas tardes queria saber una cosa sobre reciclables", CAT);
    assert.equal(r.porAtajo, false);
  });

  it("con texto vacío no rompe", async () => {
    for (const texto of ["", "   "]) {
      const r = await clasificar(texto, CAT);
      assert.ok(r.intencion, `"${texto}" devolvió intención inválida`);
    }
  });
});

describe("decidir", () => {
  it("un flujo con confianza suficiente lo arranca", () => {
    const d = decidir(clasif({ intencion: "retiro_no_habitual", confianza: 0.9 }), CAT);
    assert.deepEqual(d, { tipo: "iniciar_flujo", flujo: "retiro_no_habitual" });
  });

  it("un flujo con confianza baja NO lo arranca", () => {
    // Equivocarse de flujo le cuesta al vecino tres o cuatro preguntas inútiles
    // antes de poder corregir. Con duda, se intenta responder.
    const d = decidir(clasif({ intencion: "retiro_no_habitual", confianza: 0.3 }), CAT);
    assert.equal(d.tipo, "consultar_conocimiento");
  });

  it("respeta el umbral configurado", () => {
    const config = new Map(CAT.configuracion);
    config.set("umbral_confianza_router", 0.95);
    const estricto = catalogoPrueba({ configuracion: config });

    const c = clasif({ intencion: "reclamo_recoleccion", confianza: 0.8 });
    assert.equal(decidir(c, CAT).tipo, "iniciar_flujo", "con umbral 0.6 arranca");
    assert.equal(decidir(c, estricto).tipo, "consultar_conocimiento", "con 0.95 no");
  });

  it("una consulta libre va al conocimiento, incluso con confianza baja", () => {
    // Es la regla de «responder antes de preguntar»: la cadena ya sabe admitir
    // cuando no encuentra material. Devolverle un menú a quien hizo una
    // pregunta concreta es peor que intentar responder y fallar.
    for (const confianza of [0.9, 0.4, 0]) {
      const d = decidir(clasif({ intencion: "consulta_libre", confianza }), CAT);
      assert.equal(d.tipo, "consultar_conocimiento", `confianza ${confianza}`);
    }
  });

  it("saludo y despedida tienen su propia acción", () => {
    assert.equal(decidir(clasif({ intencion: "saludo", confianza: 1 }), CAT).tipo, "saludar");
    assert.equal(decidir(clasif({ intencion: "despedida", confianza: 1 }), CAT).tipo, "despedir");
  });

  it("lo no entendido es el único caso que va directo al menú", () => {
    const d = decidir(clasif({ intencion: "no_entendido", confianza: 0.9 }), CAT);
    assert.equal(d.tipo, "mostrar_menu");
  });

  it("con responder_antes_de_preguntar en false vuelve al menú", () => {
    // El comportamiento del bot anterior, dejado como opción configurable para
    // que Ambiente pueda comparar los dos si quiere.
    const config = new Map(CAT.configuracion);
    config.set("responder_antes_de_preguntar", false);
    const conMenu = catalogoPrueba({ configuracion: config });

    assert.equal(
      decidir(clasif({ intencion: "consulta_libre", confianza: 0.9 }), conMenu).tipo,
      "mostrar_menu",
    );
    assert.equal(
      decidir(clasif({ intencion: "retiro_no_habitual", confianza: 0.2 }), conMenu).tipo,
      "mostrar_menu",
    );
  });

  it("los cinco flujos son alcanzables", () => {
    for (const flujo of [
      "retiro_no_habitual",
      "reclamo_recoleccion",
      "programa_educa",
      "programa_transforma",
      "programa_separa",
    ] as const) {
      const d = decidir(clasif({ intencion: flujo, confianza: 0.95 }), CAT);
      assert.deepEqual(d, { tipo: "iniciar_flujo", flujo });
    }
  });
});
