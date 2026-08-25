/**
 * Qué hace el bot con cada clasificación.
 *
 * `decidir()` es una función pura: recibe la clasificación y el catálogo, y
 * devuelve una acción. No llama al modelo, así que estas pruebas son rápidas y
 * deterministas — a diferencia de `herramientas/medir-clasificador.mjs`, que sí
 * lo llama y mide si el prompt clasifica bien.
 *
 * La división importa: acá se prueba la POLÍTICA (qué hacemos con cada
 * intención) y allá la PERCEPCIÓN (si el modelo pone la etiqueta correcta). Son
 * dos cosas que se rompen por separado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidir, type Clasificacion } from "./router.ts";
import { catalogoPrueba } from "../flujos/_fixtures.ts";

const catalogo = catalogoPrueba();

function clas(parcial: Partial<Clasificacion>): Clasificacion {
  return {
    intencion: "consulta_libre",
    confianza: 0.9,
    porAtajo: false,
    modelo: "prueba",
    tokensEntrada: 0,
    tokensSalida: 0,
    costoUsd: null,
    latenciaMs: 0,
    ...parcial,
  };
}

describe("fuera de alcance", () => {
  // Se entendió el pedido y no es de Ambiente: derivar de una. Hacerle elegir
  // entre opciones que ninguna le sirve es hacerlo perder tiempo.
  it("con confianza alta deriva, sin pasar por el menú", () => {
    const d = decidir(clas({ intencion: "fuera_de_alcance", confianza: 0.9 }), catalogo);
    assert.equal(d.tipo, "derivar");
  });

  // EL CASO QUE PROTEGE AL VECINO. El área pidió que el menú actúe de red contra
  // NUESTROS errores de clasificación, y la confianza es la medida de eso: si el
  // modelo duda, puede ser un pedido de Ambiente mal leído, y derivarlo sería
  // echar a alguien por una falla propia.
  it("con confianza baja NO deriva: muestra el menú", () => {
    const d = decidir(clas({ intencion: "fuera_de_alcance", confianza: 0.3 }), catalogo);
    assert.equal(
      d.tipo,
      "mostrar_menu",
      "con el modelo dudando, derivar es echar a un vecino por un error nuestro",
    );
  });

  it("justo en el umbral deriva", () => {
    const umbral = Number(catalogo.configuracion.get("umbral_confianza_router") ?? 0.6);
    assert.equal(decidir(clas({ intencion: "fuera_de_alcance", confianza: umbral }), catalogo).tipo, "derivar");
  });
});

describe("no entendido es otra cosa", () => {
  // La distinción que motivó separar las dos intenciones: antes «necesito una
  // habilitación comercial» caía en la misma etiqueta que «asdfgh», y el modelo
  // daba 0.2 o 0.95 para la MISMA frase según cómo estuviera escrita.
  it("siempre muestra el menú, con cualquier confianza", () => {
    for (const c of [0, 0.3, 0.9, 1]) {
      assert.equal(
        decidir(clas({ intencion: "no_entendido", confianza: c }), catalogo).tipo,
        "mostrar_menu",
        `con confianza ${c}`,
      );
    }
  });
});

describe("lo que no cambió", () => {
  it("una consulta va al conocimiento, incluso con confianza baja", () => {
    assert.equal(decidir(clas({ intencion: "consulta_libre", confianza: 0.1 }), catalogo).tipo, "consultar_conocimiento");
  });

  it("un trámite con confianza alta arranca el flujo", () => {
    const d = decidir(clas({ intencion: "retiro_no_habitual", confianza: 0.9 }), catalogo);
    assert.equal(d.tipo, "iniciar_flujo");
  });

  it("un trámite con confianza baja intenta responder antes de imponer el menú", () => {
    assert.equal(decidir(clas({ intencion: "retiro_no_habitual", confianza: 0.2 }), catalogo).tipo, "consultar_conocimiento");
  });

  it("el saludo y la despedida no dependen de la confianza", () => {
    assert.equal(decidir(clas({ intencion: "saludo", confianza: 0 }), catalogo).tipo, "saludar");
    assert.equal(decidir(clas({ intencion: "despedida", confianza: 0 }), catalogo).tipo, "despedir");
  });
});
