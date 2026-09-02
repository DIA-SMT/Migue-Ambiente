import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { partirEtiqueta, renderizar } from "./renderizar.ts";
import { cuerpoDeEnvio, errorDeMeta } from "./cliente.ts";

function saliente(texto: string, opciones?: Array<{ id: string; etiqueta: string }>) {
  return { texto, ...(opciones ? { opciones } : {}) };
}

describe("renderizar: texto", () => {
  it("sin opciones parte a 4096 y nada más", () => {
    const envios = renderizar(saliente("x".repeat(5000)));
    assert.equal(envios.length, 2);
    assert.ok(envios.every((e) => e.tipo === "texto"));
  });
});

describe("renderizar: botones (hasta 3 opciones)", () => {
  it("dos opciones son botones reply con los ids intactos", () => {
    const envios = renderizar(
      saliente("¿Te sirvió?", [
        { id: "voto_util:123", etiqueta: "👍 Sí, me sirvió" },
        { id: "voto_no_util:123", etiqueta: "👎 No me sirvió" },
      ]),
    );
    assert.equal(envios.length, 1);
    const e = envios[0]!;
    if (e.tipo !== "botones") throw new Error("esperaba botones");
    assert.deepEqual(
      e.botones.map((b) => b.id),
      ["voto_util:123", "voto_no_util:123"],
    );
  });

  it("los cuatro títulos de voto entran SIN recorte", () => {
    // El centinela del canal, como el de los 49 bytes en Telegram: si alguien
    // alarga estas etiquetas, este test avisa antes de que Meta rechace nada.
    for (const etiqueta of ["👍 Sí, me sirvió", "👎 No me sirvió", "👍 Sí, fue fácil", "👎 Fue complicado"]) {
      const [e] = renderizar(saliente("¿?", [{ id: "v", etiqueta }]));
      if (e!.tipo !== "botones") throw new Error("esperaba botones");
      assert.equal(e!.botones[0]!.titulo, etiqueta, etiqueta);
    }
  });

  it("un título largo se recorta por palabra con puntos suspensivos", () => {
    const [e] = renderizar(
      saliente("¿?", [{ id: "x", etiqueta: "Escombros / material de construcción" }]),
    );
    if (e!.tipo !== "botones") throw new Error("esperaba botones");
    assert.ok([...e!.botones[0]!.titulo].length <= 20);
    assert.match(e!.botones[0]!.titulo, /…$/);
  });

  it("dos títulos que colisionan al recortar se desambiguan", () => {
    const [e] = renderizar(
      saliente("¿?", [
        { id: "a", etiqueta: "Retiro de residuos voluminosos grandes" },
        { id: "b", etiqueta: "Retiro de residuos voluminosos chicos" },
      ]),
    );
    if (e!.tipo !== "botones") throw new Error("esperaba botones");
    const titulos = e!.botones.map((b) => b.titulo);
    assert.notEqual(titulos[0], titulos[1], `quedaron iguales: ${titulos[0]}`);
  });
});

describe("renderizar: lista (4 a 10 opciones)", () => {
  // Son las etiquetas LARGAS que tenía el menú antes de la 038, y quedan a
  // propósito: lo que este bloque prueba son los topes de Meta y el recorte a
  // título + descripción, y con las etiquetas cortas de hoy ninguna fila los
  // tocaría. Los ids sí son los reales, que es lo que tiene que llegar intacto.
  const MENU = [
    { id: "retiro_no_habitual", etiqueta: "Retirar escombros, poda o muebles" },
    { id: "reclamo_recoleccion", etiqueta: "El camión no pasó" },
    { id: "programa_separa", etiqueta: "Reciclables y SEPARÁ" },
    { id: "programa_educa", etiqueta: "Taller o charla para una institución (EDUCÁ)" },
    { id: "programa_transforma", etiqueta: "Mural o intervención en un espacio (TRANSFORMÁ)" },
    { id: "consulta_libre", etiqueta: "Otra consulta" },
  ];

  it("el menú de seis opciones es una lista con los ids intactos", () => {
    const envios = renderizar(saliente("Decime con qué necesitás que te ayude.", MENU));
    assert.equal(envios.length, 1);
    const e = envios[0]!;
    if (e.tipo !== "lista") throw new Error("esperaba lista");
    assert.deepEqual(
      e.filas.map((f) => f.id),
      MENU.map((o) => o.id),
      "los ids son las intenciones del orquestador: intactos o nada",
    );
    assert.ok([...e.boton].length <= 20);
  });

  it("una etiqueta larga: título ≤24 y la etiqueta COMPLETA en la descripción", () => {
    const { titulo, descripcion } = partirEtiqueta("Taller o charla para una institución (EDUCÁ)");
    assert.ok([...titulo].length <= 24, titulo);
    assert.equal(descripcion, "Taller o charla para una institución (EDUCÁ)");
  });

  it("una etiqueta corta va entera y sin descripción", () => {
    assert.deepEqual(partirEtiqueta("Otra consulta"), { titulo: "Otra consulta", descripcion: null });
  });

  it("todas las filas respetan los topes de Meta", () => {
    const [e] = renderizar(saliente("¿?", MENU));
    if (e!.tipo !== "lista") throw new Error("esperaba lista");
    for (const f of e!.filas) {
      assert.ok([...f.titulo].length <= 24, f.titulo);
      if (f.descripcion !== null) assert.ok([...f.descripcion].length <= 72, f.descripcion);
    }
  });
});

describe("renderizar: los bordes", () => {
  it("cuerpo largo con opciones: preludios de texto y el interactivo con la cola ≤1024", () => {
    const envios = renderizar(saliente("párrafo uno\n\n" + "x".repeat(1500), [{ id: "a", etiqueta: "A" }]));
    const ultimo = envios.at(-1)!;
    assert.equal(ultimo.tipo, "botones", "el teclado va sólo en el último envío");
    assert.ok([...ultimo.texto].length <= 1024);
    assert.ok(envios.slice(0, -1).every((e) => e.tipo === "texto"));
  });

  it("once opciones degradan a texto numerado (el dominio resuelve el número)", () => {
    const muchas = Array.from({ length: 11 }, (_, i) => ({ id: `op${i}`, etiqueta: `Opción ${i + 1}` }));
    const envios = renderizar(saliente("Elegí:", muchas));
    assert.ok(envios.every((e) => e.tipo === "texto"));
    assert.match(envios[0]!.texto, /11\. Opción 11/);
  });

  it("un id imposible (>256 bytes) se descarta en silencio, como en Telegram", () => {
    const envios = renderizar(
      saliente("¿?", [
        { id: "x".repeat(300), etiqueta: "Rota" },
        { id: "ok", etiqueta: "Sana" },
      ]),
    );
    const e = envios[0]!;
    if (e.tipo !== "botones") throw new Error("esperaba botones");
    assert.deepEqual(e.botones.map((b) => b.id), ["ok"]);
  });
});

describe("cuerpoDeEnvio: la forma del wire", () => {
  it("texto con la vista previa apagada", () => {
    const c = cuerpoDeEnvio("549381", { tipo: "texto", texto: "hola" });
    assert.deepEqual(c, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "549381",
      type: "text",
      text: { body: "hola", preview_url: false },
    });
  });

  it("botones: type reply, id y title donde Meta los espera", () => {
    const c = cuerpoDeEnvio("549381", {
      tipo: "botones",
      texto: "¿?",
      botones: [{ id: "voto_util:1", titulo: "👍 Sí, me sirvió" }],
    }) as Record<string, Record<string, unknown>>;
    assert.deepEqual(c["interactive"], {
      type: "button",
      body: { text: "¿?" },
      action: { buttons: [{ type: "reply", reply: { id: "voto_util:1", title: "👍 Sí, me sirvió" } }] },
    });
  });

  it("lista: una sección, botón global, description sólo cuando hay", () => {
    const c = cuerpoDeEnvio("549381", {
      tipo: "lista",
      texto: "Elegí",
      boton: "Ver opciones",
      filas: [
        { id: "a", titulo: "Corta", descripcion: null },
        { id: "b", titulo: "Larga…", descripcion: "La etiqueta entera" },
      ],
    }) as Record<string, Record<string, unknown>>;
    const action = c["interactive"]!["action"] as {
      button: string;
      sections: Array<{ rows: Array<Record<string, unknown>> }>;
    };
    assert.equal(action.button, "Ver opciones");
    assert.equal(action.sections.length, 1);
    assert.deepEqual(action.sections[0]!.rows[0], { id: "a", title: "Corta" });
    assert.deepEqual(action.sections[0]!.rows[1], {
      id: "b",
      title: "Larga…",
      description: "La etiqueta entera",
    });
  });
});

describe("errorDeMeta", () => {
  it("saca código, subcódigo y fbtrace del cuerpo", () => {
    const e = errorDeMeta(400, {
      error: { message: "token vencido", code: 190, error_subcode: 463, fbtrace_id: "AbC" },
    });
    assert.equal(e.codigo, 190);
    assert.equal(e.subcodigo, 463);
    assert.equal(e.fbtraceId, "AbC");
    assert.equal(e.reintentable, false, "un 400 no se reintenta");
  });

  it("429 y 5xx son reintentables; el cuerpo puede venir vacío", () => {
    assert.equal(errorDeMeta(429, {}).reintentable, true);
    assert.equal(errorDeMeta(503, null).reintentable, true);
  });
});
