import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { esUtilizable, interpretarCantidad } from "./cantidad.ts";
import { validarVolumen } from "./volumen.ts";
import { LIMITES_PRUEBA } from "../flujos/_fixtures.ts";

/**
 * Este módulo acumuló tres bugs durante su construcción, así que tiene tests
 * directos y no sólo la cobertura de rebote que le daba `volumen.test.ts`.
 * Los tres casos están marcados abajo como REGRESIÓN.
 */

describe("números con unidad", () => {
  it("dígitos pegados a la unidad", () => {
    const r = interpretarCantidad("5 bolsas de escombros");
    assert.equal(r.valor, 5);
    assert.equal(r.unidad, "bolsas");
    assert.equal(r.esRango, false);
  });

  it("salta el relleno entre el número y la unidad", () => {
    for (const texto of ["como 10 bolsas", "unas 10 bolsas", "aproximadamente 10 bolsas", "10 de bolsas"]) {
      assert.equal(interpretarCantidad(texto).valor, 10, texto);
    }
  });

  it("números escritos con palabras", () => {
    assert.equal(interpretarCantidad("cinco bolsas").valor, 5);
    assert.equal(interpretarCantidad("dos metros cubicos").valor, 2);
    assert.equal(interpretarCantidad("quince kilos").valor, 15);
  });

  it("unifica metro cúbico en una sola unidad", () => {
    for (const texto of ["1 m3", "1 m³", "un metro cubico", "1 metros cubicos"]) {
      const r = interpretarCantidad(texto);
      assert.equal(r.unidad, "m3", texto);
      assert.equal(r.valor, 1, texto);
    }
  });

  it("reconoce objetos contados por unidad", () => {
    assert.equal(interpretarCantidad("3 tarimas").unidad, "unidades");
    assert.equal(interpretarCantidad("2 colchones").unidad, "unidades");
    assert.equal(interpretarCantidad("un sillon").unidad, "unidades");
  });
});

describe("REGRESIÓN · el separador decimal no debe partir el número", () => {
  it("coma decimal", () => {
    // Antes: "0,2 m3" se partía en los tokens "0" y "2" y se leía como el
    // RANGO 0 a 2, porque la normalización barría toda la puntuación.
    const r = interpretarCantidad("0,2 m3");
    assert.equal(r.valor, 0.2);
    assert.equal(r.esRango, false, "no debe interpretarse como rango");
    assert.equal(r.valorMaximo, null);
  });

  it("punto decimal", () => {
    const r = interpretarCantidad("1.5 metros cubicos");
    assert.equal(r.valor, 1.5);
    assert.equal(r.esRango, false);
  });

  it("decimal con más de un dígito", () => {
    assert.equal(interpretarCantidad("2,75 m3").valor, 2.75);
  });
});

describe("REGRESIÓN · m³ y m3 son la misma unidad", () => {
  it("el superíndice se normaliza", () => {
    // Antes: ³ es categoría Number en Unicode, sobrevivía al filtro de
    // puntuación y "m³" quedaba distinto de "m3".
    assert.equal(interpretarCantidad("1 m³ de ramas").unidad, "m3");
    assert.equal(interpretarCantidad("1 m3 de ramas").unidad, "m3");
  });
});

describe("REGRESIÓN · la vaguedad le gana a un número accidental", () => {
  it('"un camión" no es la cantidad 1', () => {
    // Antes: el "un" de "un camion" se leía como cantidad y tapaba el "mucho".
    // Un vecino con un camión de escombros no puede resolverse como 1 unidad.
    const r = interpretarCantidad("es mucho, un camion");
    assert.equal(r.vaga, "mucho");
    assert.equal(r.valor, null);
  });

  it('"un monton" tampoco', () => {
    const r = interpretarCantidad("tengo un monton");
    assert.equal(r.vaga, "mucho");
    assert.equal(r.valor, null);
  });

  it("pero un número concreto CON unidad sí gana al adjetivo", () => {
    const r = interpretarCantidad("muchas, unas 12 bolsas");
    assert.equal(r.valor, 12);
    assert.equal(r.unidad, "bolsas");
    assert.equal(r.vaga, null, "el número concreto manda");
  });
});

describe("adyacencia: el número tiene que pertenecer a la unidad", () => {
  it("un artículo lejano no es una cantidad", () => {
    // "tengo un problema con las bolsas" no son 1 bolsa. El corte lo hace
    // "las", que no es número ni relleno.
    const r = interpretarCantidad("tengo un problema con las bolsas");
    assert.equal(r.valor, null);
    assert.equal(r.unidad, "bolsas", "la unidad sí se detecta");
    assert.equal(esUtilizable(r), false, "pero no alcanza para decidir");
  });

  it("una dirección no se confunde con una cantidad", () => {
    const r = interpretarCantidad("vivo en Muñecas al 200 y tengo bolsas");
    assert.equal(r.valor, null, "el 200 de la dirección no es cantidad de bolsas");
  });
});

describe("rangos", () => {
  it("captura los dos extremos", () => {
    const r = interpretarCantidad("entre 5 y 10 bolsas");
    assert.equal(r.valor, 5);
    assert.equal(r.valorMaximo, 10);
    assert.equal(r.esRango, true);
  });

  it("ordena los extremos aunque vengan al revés", () => {
    const r = interpretarCantidad("entre 10 y 5 bolsas");
    assert.equal(r.valor, 5);
    assert.equal(r.valorMaximo, 10);
  });

  it("un rango no arrastra vaguedad", () => {
    assert.equal(interpretarCantidad("entre 5 y 10 bolsas").vaga, null);
  });
});

describe("términos vagos", () => {
  it("clasifica en poco, medio y mucho", () => {
    assert.equal(interpretarCantidad("poco").vaga, "poco");
    assert.equal(interpretarCantidad("poquito nada mas").vaga, "poco");
    assert.equal(interpretarCantidad("medio").vaga, "medio");
    assert.equal(interpretarCantidad("mas o menos").vaga, "medio");
    assert.equal(interpretarCantidad("bastante").vaga, "mucho");
    assert.equal(interpretarCantidad("es enorme").vaga, "mucho");
  });

  it('"medio" con unidad es 0,5 y no vaguedad', () => {
    const r = interpretarCantidad("medio metro cubico");
    assert.equal(r.valor, 0.5);
    assert.equal(r.unidad, "m3");
    assert.equal(r.vaga, null);
  });
});

describe("sin datos aprovechables", () => {
  it("texto sin cantidad ni vaguedad", () => {
    const r = interpretarCantidad("necesito que retiren esto por favor");
    assert.equal(r.valor, null);
    assert.equal(r.unidad, null);
    assert.equal(r.vaga, null);
    assert.equal(esUtilizable(r), false);
  });

  it("texto vacío no explota", () => {
    for (const texto of ["", "   ", "!!!", "?"]) {
      const r = interpretarCantidad(texto);
      assert.equal(r.valor, null);
      assert.equal(r.textoOriginal, texto);
    }
  });

  it("conserva el texto original para poder auditar", () => {
    const original = "Como 10 BOLSAS de escombros";
    assert.equal(interpretarCantidad(original).textoOriginal, original);
  });
});

describe("esUtilizable", () => {
  it("exige valor y unidad", () => {
    assert.equal(esUtilizable(interpretarCantidad("5 bolsas")), true);
    assert.equal(esUtilizable(interpretarCantidad("mucho")), false);
    assert.equal(esUtilizable(interpretarCantidad("tengo bolsas")), false);
  });
});

describe("unidades fuera de la escala del servicio", () => {
  it("REGRESIÓN · «3 toneladas» no se lee como 3 bolsas", () => {
    // EL BUG, con un ticket real en la base: «tengo 3 toneladas de piedras» no
    // tenía unidad conocida, el 3 quedaba como número suelto, y `validarVolumen`
    // le aplicaba la unidad del límite. El ticket decía «3 bolsas», DENTRO del
    // servicio gratuito. Una cuadrilla salía a levantar tres bolsas.
    const c = interpretarCantidad("tengo 3 toneladas de piedras");
    assert.equal(c.unidad, "m3", "se expresa en la unidad que el sistema sabe comparar");
    assert.equal(c.valor, 1.5);
  });

  it("el factor es un PISO: subestima, nunca al revés", () => {
    // Una tonelada de escombro compactado ronda los 0,67 m³. Se toma 0,5, que es
    // el valor más bajo que puede tomar en la práctica: si con el piso ya
    // excede, con el real excede más.
    assert.equal(interpretarCantidad("1 tonelada").valor, 0.5);
    assert.equal(interpretarCantidad("media tonelada").valor, 0.25);
    assert.equal(interpretarCantidad("2 toneladas").valor, 1);
  });

  it("un volquete sin número es un volquete, no cero", () => {
    assert.equal(interpretarCantidad("un volquete de escombros").valor, 2.5);
    assert.equal(interpretarCantidad("necesito un contenedor").valor, 2.5);
    assert.equal(interpretarCantidad("2 volquetes").valor, 5);
  });

  it("gana sobre una unidad chica nombrada en el mismo mensaje", () => {
    // Sin esto, «3 toneladas y 2 bolsas» dejaría ganar a las bolsas y el pedido
    // volvería a leerse como si entrara en el servicio gratuito.
    assert.equal(interpretarCantidad("hay 3 toneladas y 2 bolsas").unidad, "m3");
    assert.equal(interpretarCantidad("hay 3 toneladas y 2 bolsas").valor, 1.5);
  });

  it("y el pedido termina EXCEDIENDO el límite, nunca dentro", () => {
    // Lo que importa es que NINGUNO caiga en «dentro»: eso era el bug.
    const limite = LIMITES_PRUEBA.find((l) => l.categoria === "escombros")!;
    for (const texto of ["tengo 3 toneladas de piedras", "un volquete", "2 toneladas"]) {
      assert.equal(validarVolumen(interpretarCantidad(texto), limite).tipo, "excede", texto);
    }
  });

  it("cerca del límite sigue preguntando, que es lo que protege al piso", () => {
    // «media tonelada» con el piso da 6,25 bolsas contra un límite de 5: cae
    // dentro del ±25% donde la conversión no alcanza para decidir. El módulo
    // pregunta en vez de arriesgar, y es justo lo que hace que usar un factor
    // aproximado sea aceptable.
    const limite = LIMITES_PRUEBA.find((l) => l.categoria === "escombros")!;
    const r = validarVolumen(interpretarCantidad("media tonelada"), limite);
    assert.equal(r.tipo, "precisar");
    assert.equal(r.tipo === "precisar" ? r.motivo : null, "demasiado_cerca_del_limite");
  });

  it("no toca los casos que ya andaban", () => {
    assert.equal(interpretarCantidad("8 bolsas").valor, 8);
    assert.equal(interpretarCantidad("8 bolsas").unidad, "bolsas");
    assert.equal(interpretarCantidad("2 m3").unidad, "m3");
    assert.equal(interpretarCantidad("tengo un problema con las bolsas").valor, null);
  });

  it("«medio» y «media» solos siguen siendo vaguedad, no el número 0,5", () => {
    assert.equal(interpretarCantidad("medio").vaga, "medio");
    assert.equal(interpretarCantidad("medio").valor, null);
    assert.equal(interpretarCantidad("es medio nomas").vaga, "medio");
    // Pero con una unidad al lado son media unidad.
    assert.equal(interpretarCantidad("media bolsa").valor, 0.5);
  });
});
