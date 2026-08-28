import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interpretarCantidad } from "./cantidad.ts";
import { LIMITES_PRUEBA } from "../flujos/_fixtures.ts";
import {
  detectarCategoria,
  limiteDe,
  preguntaParaPrecisar,
  validarVolumen,
  type LimiteVolumen,
} from "./volumen.ts";

/** Los límites tal como los siembra la migración 008, desde la spec. */
const LIMITES: LimiteVolumen[] = [
  {
    categoria: "escombros",
    etiqueta: "Escombros / Material de construcción",
    limiteValor: 5,
    limiteUnidad: "bolsas",
    pesoMaxBolsaKg: 15,
    accionAlExceder: "parcial_con_ticket",
    textoExceso: "Excede el límite. Retiramos hasta el máximo permitido.",
    palabras: ["escombro","escombros","ladrillo","cascote","cemento"],
    activo: true,
  },
  {
    categoria: "poda",
    etiqueta: "Restos de Poda / Ramas",
    limiteValor: 10,
    limiteUnidad: "bolsas",
    pesoMaxBolsaKg: null,
    accionAlExceder: "parcial_con_ticket",
    textoExceso: null,
    palabras: ["poda","rama","ramas","pasto","hojas"],
    activo: true,
  },
  {
    categoria: "voluminosos",
    etiqueta: "Voluminosos",
    limiteValor: 1,
    limiteUnidad: "m3",
    pesoMaxBolsaKg: null,
    accionAlExceder: "parcial_con_ticket",
    textoExceso: null,
    palabras: ["mueble","sillon","colchon","heladera","tarima"],
    activo: true,
  },
];

const escombros = limiteDe("escombros", LIMITES)!;
const poda = limiteDe("poda", LIMITES)!;
const voluminosos = limiteDe("voluminosos", LIMITES)!;

/** Atajo: texto libre del vecino -> resultado de validación. */
function evaluar(texto: string, limite: LimiteVolumen) {
  return validarVolumen(interpretarCantidad(texto), limite);
}

describe("límites en la misma unidad", () => {
  it("5 bolsas de escombros entra (el límite es inclusivo)", () => {
    const r = evaluar("5 bolsas", escombros);
    assert.equal(r.tipo, "dentro");
  });

  it("6 bolsas de escombros excede", () => {
    const r = evaluar("6 bolsas", escombros);
    assert.equal(r.tipo, "excede");
    if (r.tipo !== "excede") return;
    assert.equal(r.accion, "parcial_con_ticket");
    assert.match(r.texto, /excede/i);
  });

  it("10 bolsas de poda entra pero 11 no", () => {
    assert.equal(evaluar("10 bolsas", poda).tipo, "dentro");
    assert.equal(evaluar("11 bolsas", poda).tipo, "excede");
  });

  it("usa el texto de exceso cargado en la base cuando existe", () => {
    const r = evaluar("20 bolsas", escombros);
    if (r.tipo !== "excede") return assert.fail("debería exceder");
    assert.equal(r.texto, escombros.textoExceso);
  });

  it("genera un texto de exceso razonable cuando la base no trae uno", () => {
    const r = evaluar("30 bolsas", poda);
    if (r.tipo !== "excede") return assert.fail("debería exceder");
    assert.match(r.texto, /10 bolsas/);
    assert.match(r.texto, /Punto Verde/i);
  });
});

describe("ante la duda, preguntar", () => {
  it("cantidad vaga no decide: pregunta", () => {
    for (const texto of ["poco", "es mucho", "un monton", "medio"]) {
      const r = evaluar(texto, escombros);
      assert.equal(r.tipo, "precisar", `"${texto}" debería pedir precisión`);
      if (r.tipo === "precisar") assert.equal(r.motivo, "cantidad_vaga");
    }
  });

  it("sin cantidad, pregunta", () => {
    const r = evaluar("tengo escombros para retirar", escombros);
    assert.equal(r.tipo, "precisar");
    if (r.tipo === "precisar") assert.equal(r.motivo, "sin_cantidad");
  });

  it("un rango que cruza el límite es ambiguo: pregunta", () => {
    const r = evaluar("entre 3 y 8 bolsas", escombros);
    assert.equal(r.tipo, "precisar");
    if (r.tipo === "precisar") assert.equal(r.motivo, "rango_ambiguo");
  });

  it("un rango enteramente por debajo del límite entra sin preguntar", () => {
    assert.equal(evaluar("entre 2 y 4 bolsas", escombros).tipo, "dentro");
  });

  it("un rango enteramente por encima excede, evaluado por el techo", () => {
    const r = evaluar("entre 8 y 12 bolsas", escombros);
    assert.equal(r.tipo, "excede");
    if (r.tipo === "excede") assert.equal(r.valorEvaluado, 12);
  });

  it("cantidades en unidades (muebles) nunca deciden solas", () => {
    // No hay factor honesto entre "tres sillas" y un metro cúbico.
    const r = evaluar("un sillon y dos sillas", voluminosos);
    assert.equal(r.tipo, "precisar");
    if (r.tipo === "precisar") assert.equal(r.motivo, "unidad_no_convertible");
  });
});

describe("conversión entre unidades", () => {
  it("m³ claramente por encima del límite en bolsas excede", () => {
    // 2 m³ son ~50 bolsas contra un límite de 5: no hay ambigüedad posible.
    const r = evaluar("2 metros cubicos", escombros);
    assert.equal(r.tipo, "excede");
    if (r.tipo === "excede") assert.equal(r.convertido, true);
  });

  it("un valor convertido cerca del límite no se resuelve por conversión", () => {
    // 0.2 m³ / 0.04 = 5 bolsas exactas: justo el límite, con un factor
    // aproximado. Decidirlo sería fingir precisión que no tenemos.
    const r = evaluar("0,2 m3", escombros);
    assert.equal(r.tipo, "precisar");
    if (r.tipo === "precisar") assert.equal(r.motivo, "demasiado_cerca_del_limite");
  });

  it("kilos se convierten a bolsas si la categoría declara el peso por bolsa", () => {
    // Escombros: 15 kg por bolsa. 150 kg = 10 bolsas > 5.
    const r = evaluar("150 kg", escombros);
    assert.equal(r.tipo, "excede");
  });

  it("kilos NO se convierten si la categoría no declara peso por bolsa", () => {
    // Poda no tiene peso de referencia en la spec, así que no se inventa.
    const r = evaluar("150 kg", poda);
    assert.equal(r.tipo, "precisar");
    if (r.tipo === "precisar") assert.equal(r.motivo, "unidad_no_convertible");
  });

  it("bolsas contra un límite en m³ se convierte cuando está lejos", () => {
    // 50 bolsas = 2 m³ contra 1 m³.
    const r = evaluar("50 bolsas", voluminosos);
    assert.equal(r.tipo, "excede");
    if (r.tipo === "excede") assert.equal(r.convertido, true);
  });

  it("si el vecino no dice unidad, se asume la del límite", () => {
    const r = evaluar("son 3", escombros);
    assert.equal(r.tipo, "dentro");
    if (r.tipo === "dentro") assert.equal(r.convertido, false);
  });
});

describe("la acción al exceder es configurable", () => {
  it("respeta derivar_sin_ticket cuando así está cargado", () => {
    const sinTicket: LimiteVolumen = { ...escombros, accionAlExceder: "derivar_sin_ticket" };
    const r = evaluar("20 bolsas", sinTicket);
    assert.equal(r.tipo, "excede");
    if (r.tipo === "excede") assert.equal(r.accion, "derivar_sin_ticket");
  });
});

describe("preguntaParaPrecisar", () => {
  it("da UNA pregunta concreta, no un cuestionario", () => {
    for (const motivo of [
      "sin_cantidad",
      "cantidad_vaga",
      "rango_ambiguo",
      "unidad_no_convertible",
      "demasiado_cerca_del_limite",
    ] as const) {
      const pregunta = preguntaParaPrecisar({ limite: escombros, motivo });
      assert.ok(pregunta.length > 20, "la pregunta debe ser informativa");
      const signos = (pregunta.match(/\?/g) ?? []).length;
      assert.ok(signos <= 1, `"${pregunta}" tiene ${signos} preguntas, debería tener una`);
    }
  });

  it("menciona el límite, así el vecino sabe contra qué se mide", () => {
    const pregunta = preguntaParaPrecisar({ limite: escombros, motivo: "cantidad_vaga" });
    assert.match(pregunta, /5 bolsas/);
  });

  it("escribe m³ y no m3 cuando le habla al vecino", () => {
    const pregunta = preguntaParaPrecisar({ limite: voluminosos, motivo: "rango_ambiguo" });
    assert.match(pregunta, /m³/);
    assert.doesNotMatch(pregunta, /\bm3\b/);
  });
});

describe("limiteDe", () => {
  it("encuentra la categoría pedida", () => {
    assert.equal(limiteDe("poda", LIMITES)?.limiteValor, 10);
  });

  it("ignora los límites desactivados", () => {
    const apagados = LIMITES.map((l) => ({ ...l, activo: false }));
    assert.equal(limiteDe("poda", apagados), null);
  });
});

describe("detectarCategoria", () => {
  it("reconoce cada categoría por su vocabulario", () => {
    assert.equal(detectarCategoria("tengo unos escombros de la obra", LIMITES), "escombros");
    assert.equal(detectarCategoria("junte ramas y hojas", LIMITES), "poda");
    assert.equal(detectarCategoria("quiero tirar un colchon", LIMITES), "voluminosos");
  });

  it("gana la categoría con MÁS coincidencias, no la primera", () => {
    // Mensaje mixto real: menciona un mueble pero el volumen es de obra.
    // Si se quedara con la primera coincidencia elegiría el límite equivocado.
    const texto = "saque un mueble y quedaron ladrillos, cascotes y cemento de la obra";
    assert.equal(detectarCategoria(texto, LIMITES), "escombros");
  });

  it("ante un empate NO adivina: devuelve null para que el flujo pregunte", () => {
    // Una palabra de cada lado. Elegir un límite al azar seria peor que preguntar.
    assert.equal(detectarCategoria("tengo un colchon y unos ladrillos", LIMITES), null);
  });

  it("devuelve null si no reconoce nada", () => {
    assert.equal(detectarCategoria("necesito que retiren esto", LIMITES), null);
    assert.equal(detectarCategoria("", LIMITES), null);
  });

  it("es insensible a acentos y plurales", () => {
    assert.equal(detectarCategoria("hay que sacar la PODA del fondo", LIMITES), "poda");
    assert.equal(detectarCategoria("tengo cascotes", LIMITES), "escombros");
  });

  it("ignora los límites desactivados", () => {
    const soloEscombros = LIMITES.map((l) => ({ ...l, activo: l.categoria === "escombros" }));
    assert.equal(detectarCategoria("junte ramas y hojas", soloEscombros), null);
  });

  it("no confunde palabras que contienen el término", () => {
    // "rama" no debe coincidir con "programa" ni "dramatico".
    assert.equal(detectarCategoria("consulta sobre el programa separa", LIMITES), null);
  });
});

describe("el peso por bolsa, la mitad del límite que no se validaba", () => {
  const escombros = LIMITES_PRUEBA.find((l) => l.categoria === "escombros")!;

  it("REGRESIÓN · «5 bolsas de 30 kilos» no entra en el servicio gratuito", () => {
    // La spec pone DOS condiciones: «> 5 bolsas O > 15 kg c/u». Sólo se validaba
    // la primera, así que 150 kg de escombros entraban como si estuvieran dentro
    // del límite. El peso máximo por bolsa existía en la tabla y se usaba nada
    // más que para convertir cuando el vecino declaraba en kilos.
    const c = interpretarCantidad("5 bolsas de 30 kilos");
    assert.equal(c.valor, 5, "la cuenta de bolsas se lee igual que antes");
    assert.equal(c.pesoPorUnidadKg, 30);
    assert.equal(validarVolumen(c, escombros).tipo, "excede");
  });

  it("con bolsas dentro del peso, decide la cantidad como siempre", () => {
    assert.equal(validarVolumen(interpretarCantidad("5 bolsas de 10 kilos"), escombros).tipo, "dentro");
    assert.equal(validarVolumen(interpretarCantidad("5 bolsas"), escombros).tipo, "dentro");
  });

  it("«cada una» y «c/u» también cuentan", () => {
    assert.equal(interpretarCantidad("3 bolsas de 20 kg cada una").pesoPorUnidadKg, 20);
    assert.equal(validarVolumen(interpretarCantidad("3 bolsas de 20 kg cada una"), escombros).tipo, "excede");
  });

  it("un peso TOTAL no se confunde con el peso por bolsa", () => {
    // «30 kilos de escombros» son 30 en total, no 30 por bolsa. Sin la condición
    // de que los kilos vengan después de la palabra bolsa, se multiplicaba el
    // pedido por la nada.
    const c = interpretarCantidad("30 kilos de escombros");
    assert.equal(c.pesoPorUnidadKg, null);
    assert.equal(validarVolumen(c, escombros).tipo, "dentro", "30 kg son 2 bolsas");
  });

  it("sin peso máximo cargado, no se controla nada", () => {
    // Sólo escombros tiene los 15 kg. Poda y voluminosos no, y ahí el peso que
    // declare el vecino es información, no un límite.
    const poda = LIMITES_PRUEBA.find((l) => l.categoria === "poda")!;
    assert.equal(validarVolumen(interpretarCantidad("3 bolsas de 40 kilos"), poda).tipo, "dentro");
  });
});

describe("las ramas enfardadas van con los voluminosos", () => {
  it("REGRESIÓN · «ramas enfardadas» no es poda", () => {
    // La spec pone «Otros (Muebles, chatarra, ramas enfardadas)» con límite de
    // 1 m³. El detector sólo veía «rama» y «ramas», que son de poda, y el fardo
    // se medía contra 10 bolsas.
    assert.equal(detectarCategoria("tengo ramas enfardadas", LIMITES_PRUEBA), "voluminosos");
    assert.equal(detectarCategoria("un fardo de ramas", LIMITES_PRUEBA), "voluminosos");
    assert.equal(detectarCategoria("dos fardos de ramas", LIMITES_PRUEBA), "voluminosos");
  });

  it("las ramas sueltas siguen siendo poda", () => {
    assert.equal(detectarCategoria("tengo ramas y hojas", LIMITES_PRUEBA), "poda");
    assert.equal(detectarCategoria("restos de poda", LIMITES_PRUEBA), "poda");
  });

  it("una frase le gana a la palabra suelta que tiene adentro", () => {
    // Es lo que resuelve el empate: «ramas enfardadas» le da dos coincidencias a
    // cada categoría, y la frase es evidencia más fuerte que la palabra corta.
    // Ojo con compararlas alfabéticamente: «fardo de ramas» pierde contra
    // «ramas» por empezar con f.
    assert.equal(detectarCategoria("un fardo de ramas", LIMITES_PRUEBA), "voluminosos");
  });

  it("pero un empate entre dos palabras sueltas sigue preguntando", () => {
    // No adivinar cuando la evidencia es pareja: elegir un límite al azar es
    // peor que una pregunta.
    assert.equal(detectarCategoria("tengo ramas y muebles", LIMITES_PRUEBA), null);
  });

  it("y el conteo sigue mandando cuando no hay empate", () => {
    assert.equal(
      detectarCategoria("saque los muebles y quedaron ladrillos y cascotes de la obra", LIMITES_PRUEBA),
      "escombros",
    );
  });
});
