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
import {
  DEFINICIONES,
  enlaceDeWhatsapp,
  numeroDelEnlace,
  numeroParaAviso,
  validarValor,
} from "./reglas.ts";

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

describe("numeroParaAviso", () => {
  // Las mismas formas que acepta el enlace tienen que dar los mismos digitos:
  // el area escribe el numero como lo tiene en la agenda, no en formato de API.
  for (const forma of [
    "3812067777",
    "381 206 7777",
    "0381 15 206 7777",
    "+54 9 381 206 7777",
    "https://wa.me/5493812067777",
  ]) {
    it(`«${forma}» → los mismos digitos`, () => {
      assert.equal(numeroParaAviso(forma), "5493812067777");
    });
  }

  // `enlace_migue` SI acepta cualquier URL, porque el vecino la abre. Aca no:
  // a una pagina web no se le puede mandar un aviso. Los dos campos se parecen
  // en la pantalla, asi que la diferencia esta probada y no solo comentada.
  it("una direccion web no sirve como destino, aunque el enlace si la acepte", () => {
    assert.equal(enlaceDeWhatsapp("https://smt.gob.ar/contacto"), "https://smt.gob.ar/contacto");
    assert.equal(numeroParaAviso("https://smt.gob.ar/contacto"), null);
  });

  for (const basura of ["", "   ", "no se", "123"]) {
    it(`«${basura}» no es un telefono`, () => {
      assert.equal(numeroParaAviso(basura), null);
    });
  }
});

describe("numeroParaAviso · lo que NO puede entrar como destino", () => {
  // Cada uno de estos se ACEPTABA antes, guardando un destino que no existe.
  // El aviso a un numero equivocado no lo reclama nadie: el vecino no sabe que
  // alguien tenia que enterarse, y el area no sabe que el aviso salio mal.
  const NO: [string, string][] = [
    ["+54 9 381 206 7777 int 24", "el interno se le pega y quedan 15 digitos"],
    ["+54 9 381 206 7777 / 381 206 7778", "dos numeros en una linea se concatenan"],
    ["54 381 206 7777 - Ana Perez oficina 3", "el 3 de «oficina 3» se le pega"],
    ["381 206 7777 Ana", "el nombre se tiraba en silencio y el numero entraba igual"],
    ["+1 202 555 0173", "un numero de otro pais se convertia en argentino"],
    ["+56 9 1234 5678", "idem con Chile"],
    ["9 381 206 7777", "el 9 de celular sin el 54 daba 54993812067777"],
    ["https://smt.gob.ar/contacto", "a una pagina no se le manda un aviso"],
  ];
  for (const [entrada, porQue] of NO) {
    it(`rechaza «${entrada}»: ${porQue}`, () => {
      assert.equal(numeroParaAviso(entrada), null);
    });
  }

  // El mismo enlace se aceptaba o no segun si traia la cola «?text=».
  it("un enlace de wa.me entra con cola y sin cola", () => {
    assert.equal(numeroParaAviso("https://wa.me/5493812067777?text=hola"), "5493812067777");
    assert.equal(numeroParaAviso("wa.me/5493812067777"), "5493812067777");
  });
});
describe("validarValor · a quien avisarle cuando piden un asesor", () => {
  const def = DEFINICIONES.get("asesor_avisar_a")!;

  it("la clave esta en la pantalla y marcada como no conectada", () => {
    assert.ok(
      DEFINICIONES.has("asesor_avisar_a"),
      "tiene que estar en GRUPOS_DE_REGLAS o el area no la puede cargar desde el panel",
    );
    assert.equal(def.tipo, "lista");
    // Mientras el aviso no salga, el campo TIENE que decirlo. Un campo que se
    // guarda y no hace nada, sin avisarlo, deja a alguien tranquilo por nada.
    assert.ok(def.huerfana, "hasta que el aviso exista tiene que estar marcada");
  });

  it("vacio es valido y significa no avisarle a nadie", () => {
    assert.deepEqual(validarValor(def, ""), { ok: true, valor: [] });
  });

  it("normaliza cada numero al guardar", () => {
    // Dos lineas de verdad: es lo que produce el textarea de la pantalla.
    const dos = `3812067777
0381 15 206 7778`;
    assert.deepEqual(validarValor(def, dos), {
      ok: true,
      valor: ["5493812067777", "5493812067778"],
    });
  });

  it("el mismo numero escrito de dos formas se guarda una sola vez", () => {
    // Si no, esa persona recibe dos mensajes por cada pedido.
    assert.deepEqual(validarValor(def, "3812067777, +54 9 381 206 7777"), {
      ok: true,
      valor: ["5493812067777"],
    });
  });

  it("rechaza lo que no es un telefono y dice cual fue", () => {
    const conBasura = `3812067777
no se`;
    const r = validarValor(def, conBasura);
    if (r.ok) throw new Error("tendria que haber rechazado «no se»");
    assert.match(r.mensaje, /no se/);
  });
});
