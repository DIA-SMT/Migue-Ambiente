/**
 * El enlace de WhatsApp.
 *
 * Existe porque el formato internacional argentino para celulares tiene dos
 * trampas que no son obvias, y equivocarse no da ningún error: el enlace se
 * guarda, y falla recién cuando un vecino lo toca — y ahí nadie se entera.
 *
 *   · va `54` y después un `9` que NO está en el número que uno marca;
 *   · el `15` que se usa para llamar dentro del país NO va.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enlaceDeWhatsapp, numeroDelEnlace } from "./reglas.ts";

const ESPERADO = "https://wa.me/5493812067777";

describe("enlaceDeWhatsapp", () => {
  // Todas estas son formas en que alguien puede escribir el mismo número, y las
  // siete tienen que dar lo mismo. Es el punto: que nadie tenga que saber el
  // formato internacional.
  for (const forma of [
    "3812067777",
    "381 206 7777",
    "381-206-7777",
    "(381) 206-7777",
    "0381 15 206 7777",
    "+54 9 381 206 7777",
    "54 9 381 206 7777",
    "5493812067777",
  ]) {
    it(`«${forma}» → el mismo enlace`, () => {
      assert.equal(enlaceDeWhatsapp(forma), ESPERADO);
    });
  }

  // Un número con país pero SIN el 9. Es el error más fácil de cometer: se copia
  // de una factura o de una web y falta el dígito que WhatsApp necesita.
  it("agrega el 9 si viene el país y falta", () => {
    assert.equal(enlaceDeWhatsapp("543812067777"), ESPERADO);
  });

  it("respeta un enlace ya armado, sin tocarlo", () => {
    assert.equal(enlaceDeWhatsapp("https://wa.me/5493812067777"), ESPERADO);
    // Y cualquier otro enlace, porque el área puede querer derivar a una web.
    assert.equal(
      enlaceDeWhatsapp("https://smt.gob.ar/contacto"),
      "https://smt.gob.ar/contacto",
    );
  });

  // Rechazar es importante: guardar algo que no abre nada es peor que no guardar,
  // porque el bot igual lo va a mandar y el vecino va a tocar un enlace muerto.
  for (const basura of ["", "   ", "abc", "12", "wa.me/algo", "381"]) {
    it(`rechaza «${basura}»`, () => {
      assert.equal(enlaceDeWhatsapp(basura), null);
    });
  }
});

describe("numeroDelEnlace", () => {
  it("lo devuelve legible, para poder compararlo con una agenda", () => {
    assert.equal(numeroDelEnlace(ESPERADO), "+54 9 381 206-7777");
  });

  it("devuelve null si el enlace no es de WhatsApp", () => {
    assert.equal(numeroDelEnlace("https://smt.gob.ar/contacto"), null);
  });
});
