import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crearLimiteDeFrecuencia } from "./limite.ts";

describe("crearLimiteDeFrecuencia", () => {
  it("deja pasar hasta el tope y frena el siguiente", () => {
    const limite = crearLimiteDeFrecuencia({ maxPorVentana: 3 });
    assert.equal(limite.excede("juan"), false);
    assert.equal(limite.excede("juan"), false);
    assert.equal(limite.excede("juan"), false);
    assert.equal(limite.excede("juan"), true, "el cuarto se pasa");
    limite.detener();
  });

  it("pasada la ventana, el contador arranca de nuevo", async () => {
    const limite = crearLimiteDeFrecuencia({ ventanaMs: 20, maxPorVentana: 1 });
    assert.equal(limite.excede("ana"), false);
    assert.equal(limite.excede("ana"), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(limite.excede("ana"), false, "ventana nueva, cuenta nueva");
    limite.detener();
  });

  it("los usuarios no se pisan entre sí", () => {
    const limite = crearLimiteDeFrecuencia({ maxPorVentana: 1 });
    assert.equal(limite.excede("uno"), false);
    assert.equal(limite.excede("dos"), false, "la cubeta es por usuario");
    limite.detener();
  });
});
