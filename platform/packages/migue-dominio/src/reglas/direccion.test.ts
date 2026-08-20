import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatearDireccion, interpretarDireccion, preguntaPorDireccion } from "./direccion.ts";

/**
 * Este módulo acumuló tres bugs durante su construcción. Los tres están
 * marcados como REGRESIÓN abajo.
 *
 * El riesgo que cubre: una dirección mal interpretada manda una cuadrilla al
 * lugar equivocado, o registra un ticket al que nadie puede ir.
 */

describe("formatos habituales", () => {
  it("calle y altura", () => {
    const d = interpretarDireccion("Lavalle 500");
    assert.equal(d.calle, "Lavalle");
    assert.equal(d.numero, "500");
    assert.equal(d.completa, true);
  });

  it("con el conector «al»", () => {
    const d = interpretarDireccion("Lavalle al 500");
    assert.equal(d.calle, "Lavalle");
    assert.equal(d.numero, "500");
  });

  it("nombre de calle de varias palabras", () => {
    assert.equal(interpretarDireccion("San Juan 112").calle, "San Juan");
    assert.equal(
      interpretarDireccion("Av. Presidente Roque Saenz Peña 1500").calle,
      "Av. Presidente Roque Saenz Peña",
    );
  });

  it("altura con sufijo", () => {
    assert.equal(interpretarDireccion("Corrientes 1200 bis").numero, "1200 bis");
  });

  it("sin número explícito", () => {
    const d = interpretarDireccion("Lavalle sin numero");
    assert.equal(d.numero, "s/n");
    assert.equal(d.completa, true, "un terreno sin altura es una dirección válida");
  });

  it("tolera la coma entre calle y altura", () => {
    const d = interpretarDireccion("Lavalle, 500");
    assert.equal(d.calle, "Lavalle");
    assert.equal(d.numero, "500");
  });
});

describe("REGRESIÓN · el número de la calle no se confunde con la altura", () => {
  it("«25 de Mayo 300» es la calle 25 de Mayo, altura 300", () => {
    // Tomar el PRIMER número daría calle «de Mayo» y altura 25.
    const d = interpretarDireccion("25 de Mayo 300");
    assert.equal(d.calle, "25 de Mayo");
    assert.equal(d.numero, "300");
  });

  it("«24 de Septiembre 1200 entre X y Y» también", () => {
    const d = interpretarDireccion("24 de Septiembre 1200 entre Muñecas y Laprida");
    assert.equal(d.calle, "24 de Septiembre");
    assert.equal(d.numero, "1200");
    assert.equal(d.entreCalles, "Muñecas y Laprida");
  });
});

describe("REGRESIÓN · entre calles con la abreviatura e/", () => {
  it("«e/ » con espacio", () => {
    // Fallaba porque normalizar() convierte "e/" en "e " y destruye la marca,
    // así que la búsqueda tiene que hacerse sobre el texto original.
    const d = interpretarDireccion("Salta 45 e/ Chacabuco y Junin");
    assert.equal(d.calle, "Salta");
    assert.equal(d.numero, "45");
    assert.equal(d.entreCalles, "Chacabuco y Junin");
  });

  it("«e/» sin espacio", () => {
    assert.equal(
      interpretarDireccion("Salta 45 e/Chacabuco y Junin").entreCalles,
      "Chacabuco y Junin",
    );
  });

  it("la palabra «entre» completa", () => {
    assert.equal(
      interpretarDireccion("Av. Sarmiento 1200 entre Muñecas y Laprida").entreCalles,
      "Muñecas y Laprida",
    );
  });
});

describe("REGRESIÓN · las cláusulas del reclamo no entran en la dirección", () => {
  it("«hace 3 días» se descarta, no se guarda como referencia", () => {
    // En el flujo B el vecino escribe todo junto. Antes esto guardaba
    // «Lavalle 500, hace 3 dias que no pasan» en el campo dirección del ticket,
    // y además tomaba el 3 de los días como altura.
    const d = interpretarDireccion("Lavalle 500, hace 3 dias que no pasan");
    assert.equal(d.calle, "Lavalle");
    assert.equal(d.numero, "500");
    assert.equal(d.referencia, null, "la cláusula temporal se descarta");
    assert.equal(formatearDireccion(d), "Lavalle 500");
  });

  it("«hace una semana» tampoco", () => {
    const d = interpretarDireccion("Muñecas 200, hace una semana");
    assert.equal(formatearDireccion(d), "Muñecas 200");
  });

  it("«desde el lunes» tampoco", () => {
    assert.equal(formatearDireccion(interpretarDireccion("Salta 45 desde el lunes")), "Salta 45");
  });

  it("pero una referencia ÚTIL sí se conserva", () => {
    const d = interpretarDireccion("Bolivar 350, barrio Sur");
    assert.equal(d.referencia, "barrio Sur");
    assert.equal(formatearDireccion(d), "Bolivar 350, barrio Sur");
  });

  it("y también lo que va entre paréntesis", () => {
    assert.equal(interpretarDireccion("Lamadrid 50 (primera cuadra)").referencia, "(primera cuadra)");
  });
});

describe("REGRESIÓN · una frase de reclamo no es una dirección", () => {
  it("no acepta «no pasa el camion hace 3 dias»", () => {
    // Antes se leía como calle «no pasa el camion hace» y altura 3, y generaba
    // un ticket con una dirección a la que no se puede mandar una cuadrilla.
    const d = interpretarDireccion("no pasa el camion hace 3 dias");
    assert.equal(d.completa, false);
    assert.equal(d.calle, null);
  });

  it("no acepta otras frases con números", () => {
    for (const texto of [
      "tengo 3 bolsas en la esquina",
      "hay basura desde el 12",
      "necesito que pasen el 5",
    ]) {
      assert.equal(interpretarDireccion(texto).completa, false, `"${texto}"`);
    }
  });

  it("no acepta una frase larga aunque no tenga palabras prohibidas", () => {
    const d = interpretarDireccion("mi casa queda por la zona sur cerca del parque 900");
    assert.equal(d.completa, false, "una frase entera nunca es un nombre de calle");
  });

  it("rechaza «no sé la dirección» en vez de tomarlo como calle", () => {
    // Sin esto el bot respondía «Me falta la altura de no se la direccion».
    for (const texto of ["no se la direccion", "ni idea", "no me acuerdo", "no tengo idea"]) {
      const d = interpretarDireccion(texto);
      assert.equal(d.calle, null, `"${texto}"`);
      assert.equal(d.completa, false);
    }
  });
});

describe("casos incompletos", () => {
  it("sólo la calle: reconoce el nombre pero no está completa", () => {
    const d = interpretarDireccion("Lavalle");
    assert.equal(d.calle, "Lavalle");
    assert.equal(d.numero, null);
    assert.equal(d.completa, false);
  });

  it("un prefijo de vía solo no es una calle", () => {
    assert.equal(interpretarDireccion("Av. 500").calle, null);
  });

  it("texto vacío", () => {
    for (const texto of ["", "   ", "?"]) {
      const d = interpretarDireccion(texto);
      assert.equal(d.completa, false);
      assert.equal(d.textoOriginal, texto);
    }
  });
});

describe("preguntaPorDireccion", () => {
  it("con la dirección completa no pregunta nada", () => {
    assert.equal(preguntaPorDireccion(interpretarDireccion("Lavalle 500")), null);
  });

  it("si tiene la calle, la nombra al pedir la altura", () => {
    const p = preguntaPorDireccion(interpretarDireccion("Lavalle"))!;
    assert.match(p, /Lavalle/);
    assert.match(p, /altura|número/i);
  });

  it("si no tiene nada, da un ejemplo concreto", () => {
    const p = preguntaPorDireccion(interpretarDireccion("no se"))!;
    assert.match(p, /Lavalle al 500/, "un ejemplo enseña mejor que una instrucción");
  });

  it("nunca hace más de una pregunta", () => {
    for (const texto of ["", "Lavalle", "Av. 500", "no se la direccion"]) {
      const p = preguntaPorDireccion(interpretarDireccion(texto));
      if (p === null) continue;
      const signos = (p.match(/\?/g) ?? []).length;
      assert.ok(signos <= 1, `"${p}" tiene ${signos} preguntas`);
    }
  });
});
