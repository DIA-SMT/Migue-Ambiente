import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  armarContexto,
  buscarRespuestaFija,
  esMaterialSuficiente,
  idsDeFaqs,
  type Coincidencia,
} from "./buscar.ts";
import { catalogoPrueba } from "../flujos/_fixtures.ts";
import type { RespuestaFija } from "../datos/catalogo.ts";

function conFijas(fijas: RespuestaFija[]) {
  return catalogoPrueba({ respuestasFijas: fijas });
}

const FIJA_BASE: RespuestaFija = {
  id: "f1",
  nombre: "Prueba",
  disparadores: ["neumatico"],
  modo: "contiene",
  respuesta: "Respuesta institucional textual.",
  prioridad: 50,
};

describe("buscarRespuestaFija · modo contiene", () => {
  it("coincide por palabra completa", () => {
    const cat = conFijas([FIJA_BASE]);
    assert.equal(buscarRespuestaFija("donde llevo un neumatico", cat)?.id, "f1");
  });

  it("acepta el plural sin cargarlo", () => {
    const cat = conFijas([FIJA_BASE]);
    assert.equal(buscarRespuestaFija("tengo neumaticos viejos", cat)?.id, "f1");
  });

  it("NO coincide con palabras que contienen el disparador", () => {
    // Misma razón que en el motor de exclusiones: una respuesta fija disparada
    // por substring contesta cualquier cosa. Si el disparador es «gas», no
    // puede responder a «cuánto gasto».
    const cat = conFijas([{ ...FIJA_BASE, disparadores: ["gas"] }]);
    assert.equal(buscarRespuestaFija("cuanto gasto en bolsas", cat), null);
    assert.equal(buscarRespuestaFija("hay olor a gas", cat)?.id, "f1");
  });

  it("es insensible a acentos", () => {
    const cat = conFijas([{ ...FIJA_BASE, disparadores: ["neumático"] }]);
    assert.equal(buscarRespuestaFija("tengo un neumatico", cat)?.id, "f1");
  });
});

describe("buscarRespuestaFija · modo exacto", () => {
  it("sólo coincide con el texto completo", () => {
    const cat = conFijas([
      { ...FIJA_BASE, modo: "exacto", disparadores: ["cuando pasa el camion"] },
    ]);
    assert.equal(buscarRespuestaFija("cuando pasa el camion", cat)?.id, "f1");
    assert.equal(buscarRespuestaFija("CUANDO PASA EL CAMIÓN", cat)?.id, "f1", "normaliza");
    assert.equal(
      buscarRespuestaFija("me podes decir cuando pasa el camion?", cat),
      null,
      "exacto es exacto",
    );
  });
});

describe("buscarRespuestaFija · modo regex", () => {
  it("aplica la expresión", () => {
    const cat = conFijas([
      { ...FIJA_BASE, modo: "regex", disparadores: ["^(hola|buenas|buen dia)"] },
    ]);
    assert.equal(buscarRespuestaFija("hola como estas", cat)?.id, "f1");
    assert.equal(buscarRespuestaFija("buenas tardes", cat)?.id, "f1");
    assert.equal(buscarRespuestaFija("necesito un retiro", cat), null);
  });

  it("una regex inválida cargada en el panel no tumba el bot", () => {
    // Los disparadores los escribe un operador. Un paréntesis suelto no puede
    // dejar al bot sin responderle a nadie.
    const cat = conFijas([{ ...FIJA_BASE, modo: "regex", disparadores: ["neumatico(["] }]);
    assert.doesNotThrow(() => buscarRespuestaFija("tengo un neumatico", cat));
  });

  it("una regex inválida se prueba como texto literal", () => {
    // Es lo que probablemente quiso escribir quien la cargó.
    const cat = conFijas([{ ...FIJA_BASE, modo: "regex", disparadores: ["puntos verdes(["] }]);
    assert.equal(buscarRespuestaFija("donde hay puntos verdes([ cerca", cat)?.id, "f1");
  });
});

describe("buscarRespuestaFija · precedencia", () => {
  it("gana la de menor prioridad", () => {
    const cat = conFijas([
      { ...FIJA_BASE, id: "baja", nombre: "Baja", prioridad: 90 },
      { ...FIJA_BASE, id: "alta", nombre: "Alta", prioridad: 10 },
    ]);
    assert.equal(buscarRespuestaFija("un neumatico", cat)?.id, "alta");
  });

  it("desempata de forma determinista con prioridades iguales", () => {
    // Sin desempate estable, el bot contestaría distinto al mismo mensaje según
    // el orden en que Postgres devolvió las filas.
    const a: RespuestaFija = { ...FIJA_BASE, id: "z", nombre: "Zeta", prioridad: 50 };
    const b: RespuestaFija = { ...FIJA_BASE, id: "a", nombre: "Alfa", prioridad: 50 };
    assert.equal(buscarRespuestaFija("un neumatico", conFijas([a, b]))?.id, "a");
    assert.equal(buscarRespuestaFija("un neumatico", conFijas([b, a]))?.id, "a");
  });

  it("sin respuestas fijas cargadas devuelve null", () => {
    assert.equal(buscarRespuestaFija("cualquier cosa", conFijas([])), null);
  });

  it("con texto vacío devuelve null", () => {
    const cat = conFijas([FIJA_BASE]);
    for (const texto of ["", "   ", "???"]) {
      assert.equal(buscarRespuestaFija(texto, cat), null, `"${texto}"`);
    }
  });
});

// ---------------------------------------------------------------------------

const FAQ: Coincidencia = {
  origen: "faq",
  id: "q1",
  titulo: "¿Cuándo pasa el SEPARÁ?",
  texto: "Miércoles y sábados de 09 a 12 hs.",
  documentoTitulo: null,
  pagina: null,
  rank: 0.8,
  difuso: false,
};

const FRAGMENTO: Coincidencia = {
  origen: "fragmento",
  id: "fr1",
  titulo: "Recolección domiciliaria",
  texto: "Los servicios son 46 en total, del 1 al 20 en turno mañana.",
  documentoTitulo: "Programa CONTROLÁ",
  pagina: 12,
  rank: 0.3,
  difuso: false,
};

describe("armarContexto", () => {
  it("numera y etiqueta la procedencia de cada bloque", () => {
    // Las etiquetas son lo que permite auditar de dónde salió una respuesta
    // equivocada. Sin ellas, una respuesta rara es imposible de rastrear.
    const ctx = armarContexto([FAQ, FRAGMENTO]);
    assert.match(ctx, /^\[1\] Pregunta frecuente del área/m);
    assert.match(ctx, /\[2\] Programa CONTROLÁ, pág\. 12/);
    assert.match(ctx, /Miércoles y sábados/);
    assert.match(ctx, /46 en total/);
  });

  it("incluye el título de sección cuando existe", () => {
    assert.match(armarContexto([FRAGMENTO]), /Recolección domiciliaria/);
  });

  it("tolera un fragmento sin documento ni página", () => {
    const suelto = { ...FRAGMENTO, documentoTitulo: null, pagina: null, titulo: null };
    assert.match(armarContexto([suelto]), /\[1\] Documento institucional/);
  });

  it("con lista vacía devuelve cadena vacía", () => {
    assert.equal(armarContexto([]), "");
  });
});

describe("esMaterialSuficiente", () => {
  it("sin coincidencias no alcanza", () => {
    assert.equal(esMaterialSuficiente([]), false);
  });

  it("una coincidencia del texto completo alcanza", () => {
    assert.equal(esMaterialSuficiente([FRAGMENTO]), true);
  });

  it("SÓLO coincidencias difusas no alcanzan", () => {
    // Un resultado difuso significa que el texto completo no encontró nada y
    // estamos adivinando por parecido ortográfico. Con eso conviene registrar
    // la pregunta como no respondida antes que arriesgar un dato municipal.
    assert.equal(esMaterialSuficiente([{ ...FAQ, difuso: true }]), false);
  });

  it("una difusa junto a una firme alcanza", () => {
    assert.equal(esMaterialSuficiente([{ ...FAQ, difuso: true }, FRAGMENTO]), true);
  });
});

describe("idsDeFaqs", () => {
  it("devuelve sólo los ids de FAQs", () => {
    assert.deepEqual(idsDeFaqs([FAQ, FRAGMENTO]), ["q1"]);
  });

  it("sin FAQs devuelve lista vacía", () => {
    assert.deepEqual(idsDeFaqs([FRAGMENTO]), []);
  });
});
