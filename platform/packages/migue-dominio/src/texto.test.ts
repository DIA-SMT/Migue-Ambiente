import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contienePalabra, normalizar, primerTerminoPresente, recortar } from "./texto.ts";

describe("normalizar", () => {
  it("quita tildes y pasa a minúsculas", () => {
    assert.equal(normalizar("Recolección Diferenciada"), "recoleccion diferenciada");
    assert.equal(normalizar("Árbol caído"), "arbol caido");
    assert.equal(normalizar("PRESIÓN"), "presion");
  });

  it("convierte la ñ en n, igual que unaccent en Postgres", () => {
    // Se pierde la distinción, pero el vecino escribe las dos formas.
    assert.equal(normalizar("MUÑECAS al 200"), "munecas al 200");
    assert.equal(normalizar("munecas al 200"), "munecas al 200");
  });

  it("normaliza m³ a m3, que es la forma que compara el parser", () => {
    assert.equal(normalizar("1 m³"), "1 m3");
    assert.equal(normalizar("2 m²"), "2 m2");
  });

  it("conserva el separador decimal entre dígitos", () => {
    // Sin esta excepción "0,2 m3" se parte en dos números y se lee como rango.
    assert.equal(normalizar("0,2 m3"), "0.2 m3");
    assert.equal(normalizar("1.5 kg"), "1.5 kg");
    assert.equal(normalizar("son 2,75 metros"), "son 2.75 metros");
  });

  it("pero barre la puntuación que no separa decimales", () => {
    assert.equal(normalizar("Hola. Como estas?"), "hola como estas");
    assert.equal(normalizar("SAT (agua)"), "sat agua");
    assert.equal(normalizar("tel 381-4440012"), "tel 381 4440012");
  });

  it("colapsa espacios y recorta", () => {
    assert.equal(normalizar("  varios    espacios  "), "varios espacios");
  });

  it("con entrada vacía devuelve cadena vacía", () => {
    assert.equal(normalizar(""), "");
    assert.equal(normalizar("   "), "");
    assert.equal(normalizar("!!!"), "");
  });
});

describe("contienePalabra", () => {
  it("coincide con la palabra completa", () => {
    assert.equal(contienePalabra("siento olor a gas en casa", "gas"), true);
    assert.equal(contienePalabra("hay perdida de gas", "gas"), true);
  });

  it("NO coincide con palabras que contienen el término", () => {
    // El error más peligroso del motor de exclusiones: derivar a la
    // distribuidora de gas a alguien que preguntó cuánto gasta.
    for (const texto of [
      "cuanto gasto en bolsas",
      "ya pagas el servicio",
      "compre una gaseosa",
      "el gasoil esta caro",
      "vamos a gastar mucho",
    ]) {
      assert.equal(contienePalabra(texto, "gas"), false, `"${texto}" no debería coincidir`);
    }
  });

  it("acepta el plural español sin cargarlo a mano", () => {
    assert.equal(contienePalabra("tengo pilas viejas", "pila"), true);
    assert.equal(contienePalabra("junte varios cartones", "carton"), true);
  });

  it("pero el plural no vale al revés", () => {
    // Cargar "neumaticos" no debe agarrar "neumatico"; para eso se carga la
    // forma singular, que sí cubre el plural.
    assert.equal(contienePalabra("un neumatico", "neumaticos"), false);
    assert.equal(contienePalabra("un neumatico", "neumatico"), true);
  });

  it("no confunde palabras que empiezan igual", () => {
    assert.equal(contienePalabra("la pileta esta sucia", "pila"), false);
    assert.equal(contienePalabra("el aguacero de anoche", "agua"), false);
  });

  it("funciona con frases de varias palabras", () => {
    assert.equal(contienePalabra("se cayo un arbol caido enorme", "arbol caido"), true);
    assert.equal(contienePalabra("se cayo un arbol", "arbol caido"), false);
    assert.equal(contienePalabra("hay olor a gas fuerte", "olor a gas"), true);
  });

  it("es insensible a tildes en las dos puntas", () => {
    assert.equal(contienePalabra("mucha presión de agua", "presion"), true);
    assert.equal(contienePalabra("mucha presion de agua", "presión"), true);
  });

  it("con término vacío devuelve false y no explota", () => {
    assert.equal(contienePalabra("cualquier cosa", ""), false);
    assert.equal(contienePalabra("cualquier cosa", "   "), false);
  });

  it("no se rompe con términos que traen metacaracteres de regex", () => {
    // Las palabras las carga un operador desde el panel: puede escribir
    // cualquier cosa, incluido un paréntesis suelto.
    assert.equal(contienePalabra("reclamo del sat agua", "SAT (agua)"), true);
    assert.doesNotThrow(() => contienePalabra("texto", "a+b*c[?"));
  });
});

describe("primerTerminoPresente", () => {
  it("respeta el orden recibido", () => {
    const terminos = ["gas", "agua", "escombros"];
    assert.equal(primerTerminoPresente("hay agua y escombros", terminos), "agua");
    assert.equal(primerTerminoPresente("solo escombros", terminos), "escombros");
  });

  it("devuelve null si no hay ninguno", () => {
    assert.equal(primerTerminoPresente("consulta general", ["gas", "agua"]), null);
  });
});

describe("recortar", () => {
  it("deja los textos cortos intactos", () => {
    assert.equal(recortar("corto"), "corto");
  });

  it("recorta los largos con puntos suspensivos", () => {
    const largo = "a".repeat(400);
    const r = recortar(largo, 50);
    assert.equal(r.length, 50);
    assert.ok(r.endsWith("…"));
  });
});
