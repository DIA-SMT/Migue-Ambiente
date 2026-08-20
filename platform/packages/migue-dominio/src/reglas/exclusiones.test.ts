import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  corta,
  evaluarExclusiones,
  evaluarTodasLasExclusiones,
  type ReglaExclusion,
} from "./exclusiones.ts";

/** Réplica de las reglas que siembra la migración 008. */
const REGLAS: ReglaExclusion[] = [
  {
    id: "1",
    nombre: "Fuga de gas",
    palabras: ["gas", "olor a gas", "escape de gas", "cano roto", "medidor", "naturgy", "gasnor"],
    organismo: "Naturgy / Gasnor",
    respuesta: "Si sentís olor a gas, alejate del lugar…",
    accion: "derivar",
    prioridad: 10,
    activa: true,
  },
  {
    id: "2",
    nombre: "Agua y cloacas (SAT)",
    palabras: ["agua", "perdida de agua", "cloaca", "desborde", "presion", "sat"],
    organismo: "SAT",
    respuesta: "No corresponde a la competencia municipal…",
    accion: "derivar",
    prioridad: 20,
    activa: true,
  },
  {
    id: "3",
    nombre: "Arbol caido o rama de gran porte",
    palabras: ["arbol caido", "se cayo un arbol", "tronco", "rama enorme"],
    organismo: "Arbolado / Limpieza Urbana",
    respuesta: "Por las dimensiones corresponde a Arbolado…",
    accion: "derivar",
    prioridad: 40,
    activa: true,
  },
  {
    id: "4",
    nombre: "Neumaticos",
    palabras: ["neumatico", "cubierta", "llanta"],
    organismo: null,
    respuesta: "El retiro a domicilio está suspendido…",
    accion: "derivar",
    prioridad: 50,
    activa: true,
  },
];

describe("evaluarExclusiones", () => {
  it("detecta una fuga de gas", () => {
    const r = evaluarExclusiones("hay olor a gas en la esquina", REGLAS);
    assert.equal(r?.regla.nombre, "Fuga de gas");
  });

  it("gas gana sobre cualquier otra regla, por seguridad", () => {
    // Este es el caso que justifica la prioridad 10: un mensaje que menciona
    // gas Y escombros no puede terminar preguntando por bolsas.
    const r = evaluarExclusiones("se rompio el cano de gas y quedaron escombros", REGLAS);
    assert.equal(r?.regla.nombre, "Fuga de gas");
  });

  it("respeta el orden de prioridad cuando coinciden varias", () => {
    const r = evaluarExclusiones("hay agua y un arbol caido", REGLAS);
    assert.equal(r?.regla.nombre, "Agua y cloacas (SAT)", "agua (20) antes que arbol (40)");
  });

  it("desempata de forma determinista con prioridades iguales", () => {
    const empatadas: ReglaExclusion[] = [
      { ...REGLAS[3]!, id: "b", nombre: "Zeta", palabras: ["escombros"], prioridad: 99 },
      { ...REGLAS[3]!, id: "a", nombre: "Alfa", palabras: ["escombros"], prioridad: 99 },
    ];
    // Sin desempate estable, el resultado dependería del orden que devolvió
    // Postgres, y el bot contestaría distinto al mismo mensaje.
    for (let i = 0; i < 5; i++) {
      assert.equal(evaluarExclusiones("tengo escombros", empatadas)?.regla.nombre, "Alfa");
    }
    const alRevés = [...empatadas].reverse();
    assert.equal(evaluarExclusiones("tengo escombros", alRevés)?.regla.nombre, "Alfa");
  });

  it("informa qué palabra disparó la regla, para poder auditar", () => {
    const r = evaluarExclusiones("tengo una cubierta vieja", REGLAS);
    assert.equal(r?.regla.nombre, "Neumaticos");
    assert.equal(r?.palabra, "cubierta");
  });

  it("ignora las reglas desactivadas", () => {
    const apagadas = REGLAS.map((r) => ({ ...r, activa: false }));
    assert.equal(evaluarExclusiones("olor a gas", apagadas), null);
  });

  it("no dispara con consultas ambientales legítimas", () => {
    // El riesgo real de este motor son los falsos positivos: derivar a alguien
    // que tenía una consulta que el bot sí puede resolver.
    for (const texto of [
      "cuando pasa el camion por mi casa",
      "donde queda el punto verde mas cercano",
      "quiero solicitar un taller del programa educa",
      "necesito retirar 5 bolsas de escombros",
      "cuanto gasto si contrato un contenedor",
      "el programa separa pasa los miercoles?",
    ]) {
      const r = evaluarExclusiones(texto, REGLAS);
      assert.equal(r, null, `"${texto}" no debería derivarse (coincidió: ${r?.regla.nombre})`);
    }
  });

  it("con texto vacío devuelve null", () => {
    assert.equal(evaluarExclusiones("", REGLAS), null);
    assert.equal(evaluarExclusiones("   ", REGLAS), null);
  });

  it("sin reglas cargadas devuelve null", () => {
    assert.equal(evaluarExclusiones("olor a gas", []), null);
  });
});

describe("evaluarTodasLasExclusiones", () => {
  it("devuelve todas las coincidencias ordenadas por prioridad", () => {
    const todas = evaluarTodasLasExclusiones("hay agua, olor a gas y un arbol caido", REGLAS);
    assert.deepEqual(
      todas.map((c) => c.regla.nombre),
      ["Fuga de gas", "Agua y cloacas (SAT)", "Arbol caido o rama de gran porte"],
    );
  });

  it("cuenta cada regla una sola vez aunque coincidan varias palabras", () => {
    const todas = evaluarTodasLasExclusiones("olor a gas del medidor de gasnor", REGLAS);
    assert.equal(todas.filter((c) => c.regla.nombre === "Fuga de gas").length, 1);
  });

  it("sirve para detectar palabras demasiado genéricas en el panel", () => {
    // "agua" es genérica y aparece en consultas ambientales válidas. Esta
    // función es la que permite verlo antes de que moleste a los vecinos.
    const todas = evaluarTodasLasExclusiones("como cuido el agua en mi casa", REGLAS);
    assert.equal(todas.length, 1);
    assert.equal(todas[0]?.regla.nombre, "Agua y cloacas (SAT)");
  });
});

describe("corta", () => {
  it("derivar corta la conversación", () => {
    const r = evaluarExclusiones("olor a gas", REGLAS)!;
    assert.equal(corta(r), true);
  });

  it("advertir no corta", () => {
    const advertencia: ReglaExclusion[] = [{ ...REGLAS[3]!, accion: "advertir" }];
    const r = evaluarExclusiones("tengo un neumatico", advertencia)!;
    assert.equal(corta(r), false);
  });
});
