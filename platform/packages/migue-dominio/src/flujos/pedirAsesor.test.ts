import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flujoPedirAsesor as flujo } from "./pedirAsesor.ts";
import { dijo, efectoDe, simular } from "./_fixtures.ts";

describe("apertura", () => {
  it("pide el teléfono y explica que se puede decir que no", () => {
    const s = simular(flujo, []);
    assert.equal(s.dichos.length, 1);
    assert.match(s.dichos[0]!, /tel[eé]fono/i);
    assert.match(s.dichos[0]!, /«no»/);
  });
});

describe("con teléfono", () => {
  it("un número suelto crea la alerta y confirma con el número", () => {
    const s = simular(flujo, [{ texto: "381 5123456" }]);
    assert.equal(s.estado, null, "el flujo terminó");
    const alerta = efectoDe(s.efectos, "crear_alerta_asesor");
    assert.equal(alerta?.datos.telefono, "381 5123456");
    assert.ok(dijo(s.dichos, "381 5123456"), "la confirmación repite el número");
  });

  it("encuentra el teléfono adentro de una frase", () => {
    const s = simular(flujo, [{ texto: "si dale, mi cel es 381 5123456, de mañana mejor" }]);
    assert.equal(efectoDe(s.efectos, "crear_alerta_asesor")?.datos.telefono, "381 5123456");
  });

  it("el motivo inicial viaja en la alerta", () => {
    const s = simular(flujo, [{ texto: "3815123456" }], undefined, {
      motivo: "quiero hablar con una persona por las ramas",
    });
    assert.equal(
      efectoDe(s.efectos, "crear_alerta_asesor")?.datos.motivo,
      "quiero hablar con una persona por las ramas",
    );
  });
});

describe("sin teléfono", () => {
  it("con «no» la alerta sale igual, sin número", () => {
    const s = simular(flujo, [{ texto: "no" }]);
    assert.equal(s.estado, null);
    const alerta = efectoDe(s.efectos, "crear_alerta_asesor");
    assert.equal(alerta?.datos.telefono, null);
    assert.ok(dijo(s.dichos, "por acá"), "avisa que la respuesta llega por el chat");
  });

  it("«no tengo» y «prefiero no darlo» también son negativas", () => {
    for (const negativa of ["no tengo", "prefiero no darlo", "no gracias"]) {
      const s = simular(flujo, [{ texto: negativa }]);
      assert.equal(s.estado, null, `«${negativa}» tendría que cerrar`);
      assert.equal(efectoDe(s.efectos, "crear_alerta_asesor")?.datos.telefono, null);
    }
  });

  it("un mensaje que no es teléfono ni negativa reintenta UNA vez", () => {
    const s = simular(flujo, [{ texto: "es por una rama caida en la vereda" }]);
    assert.equal(s.estado?.paso, "telefono", "sigue esperando");
    assert.ok(dijo(s.dichos, "caracter"), "repregunta con el ejemplo de formato");
    assert.equal(efectoDe(s.efectos, "crear_alerta_asesor"), undefined, "todavía no hay alerta");
  });

  it("al segundo mensaje sin teléfono cierra igual, con el contexto como motivo", () => {
    const s = simular(flujo, [
      { texto: "es por una rama caida en la vereda" },
      { texto: "hace dos semanas que nadie la lleva" },
    ]);
    assert.equal(s.estado, null, "el flujo cerró: no insiste para siempre");
    const alerta = efectoDe(s.efectos, "crear_alerta_asesor");
    assert.equal(alerta?.datos.telefono, null);
    assert.match(alerta?.datos.motivo ?? "", /rama caida/);
    assert.match(alerta?.datos.motivo ?? "", /dos semanas/);
  });

  it("lo que escribe mientras tanto se acumula en el motivo", () => {
    const s = simular(
      flujo,
      [{ texto: "es urgente, hay vidrios" }, { texto: "381 5123456" }],
      undefined,
      { motivo: "quiero un asesor" },
    );
    const alerta = efectoDe(s.efectos, "crear_alerta_asesor");
    assert.match(alerta?.datos.motivo ?? "", /quiero un asesor/);
    assert.match(alerta?.datos.motivo ?? "", /vidrios/);
  });
});
