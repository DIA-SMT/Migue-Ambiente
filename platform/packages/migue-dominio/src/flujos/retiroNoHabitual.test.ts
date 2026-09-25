import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flujoRetiroNoHabitual as flujo } from "./retiroNoHabitual.ts";
import {
  AHORA,
  catalogoPrueba,
  contextoPrueba,
  dijo,
  efectoDe,
  LIMITES_PRUEBA,
  simular,
} from "./_fixtures.ts";
import { esDiaHabil, formatearFechaLocal } from "../reglas/sla.ts";
import { configSla } from "../datos/catalogo.ts";

describe("apertura del flujo", () => {
  it("abre con los requisitos y el pedido de foto, en ese orden", () => {
    const s = simular(flujo, []);
    assert.equal(s.dichos.length, 2, "la spec manda los dos mensajes seguidos");
    assert.match(s.dichos[0]!, /Regla de Oro/);
    assert.match(s.dichos[0]!, /NO saques los residuos/);
    assert.match(s.dichos[1]!, /foto/i);
  });

  it("arranca esperando una imagen", () => {
    const s = simular(flujo, []);
    assert.equal(s.estado?.paso, "foto");
  });
});

describe("la foto es bloqueante", () => {
  it("no avanza si el vecino escribe en lugar de mandar la foto", () => {
    const s = simular(flujo, [{ texto: "son 3 bolsas de escombros" }]);
    assert.equal(s.estado?.paso, "foto", "sigue en el mismo paso");
    assert.ok(dijo(s.dichos, "Necesito una imagen"));
    assert.equal(efectoDe(s.efectos, "crear_ticket"), undefined, "no puede haber ticket");
  });

  it("cuenta los intentos", () => {
    const s = simular(flujo, [{ texto: "no tengo camara" }, { texto: "no puedo" }]);
    assert.equal(s.estado?.intentos, 2);
  });

  it("agotados los intentos ofrece una salida en vez de repreguntar para siempre", () => {
    // La spec dice «loop hasta recibir imagen». Un bucle sin techo deja
    // atrapado a quien no puede sacar la foto.
    const s = simular(flujo, [
      { texto: "no puedo" },
      { texto: "no tengo camara" },
      { texto: "no" },
      { texto: "no" },
    ]);
    assert.equal(s.estado, null, "el flujo se cerró");
    assert.match(s.abandonadoPor ?? "", /intentos_agotados/);
    assert.equal(efectoDe(s.efectos, "crear_ticket"), undefined, "sin datos no se crea ticket");
  });

  it("con la foto avanza SIN encolar la descarga todavía", () => {
    // La descarga va con el ticket, en el cierre. Encolarla acá creaba la
    // carrera del worker contra el ticket inexistente (photo_url null eterno).
    const s = simular(flujo, [{ imagen: "AgACAgEAAx-foto-123" }]);
    assert.equal(s.estado?.paso, "residuo");
    assert.equal(efectoDe(s.efectos, "guardar_media"), undefined);
  });

  it("el veredicto de la visión viaja hasta el ticket", () => {
    const s = simular(flujo, [
      {
        imagen: "foto-v1",
        veredicto: { veredicto: "valida", categoria: "rnh", detalle: "bolsas frente a una casa" },
      },
      { texto: "3 bolsas de escombros" },
      { texto: "Lavalle 500" },
    ]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.fotoVeredicto, "valida");
    assert.equal(t.fotoCategoria, "rnh");
    assert.equal(t.fotoDetalle, "bolsas frente a una casa");
  });

  it("sin veredicto (visión apagada o caída) el ticket queda no_evaluada", () => {
    const s = simular(flujo, [
      { imagen: "foto-v2" },
      { texto: "3 bolsas de escombros" },
      { texto: "Lavalle 500" },
    ]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.fotoVeredicto, "no_evaluada");
    assert.equal(t.fotoCategoria, null);
  });

  it("una foto que no corresponde repregunta UNA vez, con el detalle del modelo", () => {
    const s = simular(flujo, [
      {
        imagen: "selfie-1",
        veredicto: { veredicto: "no_corresponde", categoria: null, detalle: "es una selfie" },
      },
    ]);
    assert.equal(s.estado?.paso, "foto", "no avanzó");
    assert.ok(dijo(s.dichos, "es una selfie"), "el detalle se interpola");
    assert.equal(dijo(s.dichos, "{detalle}"), false, "sin marcadores sueltos");
  });

  it("a la segunda foto objetada se acepta y el ticket queda marcado", () => {
    const rechazo = {
      veredicto: "no_corresponde",
      categoria: null,
      detalle: "es una selfie",
    } as const;
    const s = simular(flujo, [
      { imagen: "selfie-1", veredicto: rechazo },
      { imagen: "selfie-2", veredicto: rechazo },
      { texto: "3 bolsas de escombros" },
      { texto: "Lavalle 500" },
    ]);
    assert.equal(s.estado, null, "el flujo terminó igual: nunca bloquea");
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.fotoVeredicto, "no_corresponde");
    assert.equal(t.fotoReferencia, "selfie-2", "quedó la segunda foto");
  });

  it("tras la objeción, una foto válida pisa el veredicto", () => {
    const s = simular(flujo, [
      {
        imagen: "selfie-1",
        veredicto: { veredicto: "no_corresponde", categoria: null, detalle: "es una selfie" },
      },
      {
        imagen: "foto-buena",
        veredicto: { veredicto: "valida", categoria: "rnh", detalle: "escombros embolsados" },
      },
      { texto: "3 bolsas de escombros" },
      { texto: "Lavalle 500" },
    ]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.fotoVeredicto, "valida");
    assert.equal(t.fotoReferencia, "foto-buena");
  });

  it("una foto dudosa NO repregunta: avanza y marca", () => {
    const s = simular(flujo, [
      {
        imagen: "foto-lejos",
        veredicto: { veredicto: "dudosa", categoria: "otros", detalle: "se ve borroso" },
      },
    ]);
    assert.equal(s.estado?.paso, "residuo", "avanzó sin objetar");
  });

  it("con retiro_foto_no_corresponde vacío la repregunta se apaga desde el panel", () => {
    const textos = new Map(catalogoPrueba().textos);
    textos.set("retiro_foto_no_corresponde", "");
    const s = simular(
      flujo,
      [
        {
          imagen: "selfie-1",
          veredicto: { veredicto: "no_corresponde", categoria: null, detalle: "es una selfie" },
        },
      ],
      contextoPrueba(catalogoPrueba({ textos })),
    );
    assert.equal(s.estado?.paso, "residuo", "aceptó directo, sin repreguntar");
  });

  it("al cerrar, la descarga sale en el mismo array y DESPUÉS del ticket", () => {
    const s = simular(flujo, [
      { imagen: "AgACAgEAAx-foto-123" },
      { texto: "3 bolsas de escombros" },
      { texto: "Lavalle 500" },
    ]);
    assert.equal(s.estado, null, "el flujo terminó");
    const tipos = s.efectos.map((e) => e.tipo);
    const iTicket = tipos.indexOf("crear_ticket");
    const iMedia = tipos.indexOf("guardar_media");
    assert.notEqual(iMedia, -1, "la descarga se encoló");
    assert.ok(iTicket < iMedia, "el ticket tiene que existir antes que el trabajo de descarga");
    const media = efectoDe(s.efectos, "guardar_media");
    assert.equal(media?.referencia, "AgACAgEAAx-foto-123");
    assert.equal(media?.proposito, "retiro_no_habitual");
  });
});

describe("tipificación y volumen", () => {
  it("acepta tipo y cantidad en un solo mensaje", () => {
    // Es el punto del QA: si el vecino ya dio el dato, no volver a preguntar.
    const s = simular(flujo, [{ imagen: "foto1" }, { texto: "3 bolsas de escombros" }]);
    assert.equal(s.estado?.paso, "direccion", "salteó la pregunta de cantidad");
  });

  it("dentro del límite no menciona ningún exceso", () => {
    const s = simular(flujo, [{ imagen: "foto1" }, { texto: "3 bolsas de escombros" }]);
    assert.equal(dijo(s.dichos, "excede"), false);
  });

  it("por encima del límite avisa y sigue con retiro parcial", () => {
    const s = simular(flujo, [{ imagen: "foto1" }, { texto: "12 bolsas de escombros" }]);
    assert.ok(dijo(s.dichos, "excede el límite"));
    assert.equal(s.estado?.paso, "direccion", "la spec registra el parcial, no corta");
    assert.equal(s.estado?.datos["retiroParcial"], true);
  });

  it("acepta la categoría por botón", () => {
    const s = simular(flujo, [{ imagen: "foto1" }, { seleccion: "poda" }, { texto: "8 bolsas" }]);
    assert.equal(s.estado?.paso, "direccion");
    assert.equal(s.estado?.datos["categoria"], "poda");
  });

  it("si no reconoce el tipo pregunta con opciones cerradas", () => {
    const s = simular(flujo, [{ imagen: "foto1" }, { texto: "unas cosas que junte" }]);
    assert.equal(s.estado?.paso, "residuo");
    assert.ok(dijo(s.dichos, "No me quedó claro"));
  });

  it("REGRESIÓN · al pedir precisión conserva la categoría", () => {
    // Sin esto, el «8 bolsas» del turno siguiente llegaba sin saber de qué era
    // y el flujo volvía a preguntar el tipo. Era un hueco del motor: la
    // transición `repetir` no podía guardar datos.
    const s = simular(flujo, [
      { imagen: "foto1" },
      { texto: "tengo escombros pero no se cuantas bolsas" },
    ]);
    assert.equal(s.estado?.paso, "residuo", "no avanza, falta la cantidad");
    assert.equal(s.estado?.datos["categoria"], "escombros", "pero ya sabe que son escombros");

    // Y con la cantidad en el turno siguiente, resuelve sin volver a preguntar.
    const s2 = simular(flujo, [
      { imagen: "foto1" },
      { texto: "tengo escombros pero no se cuantas bolsas" },
      { texto: "8" },
    ]);
    assert.equal(s2.estado?.paso, "direccion");
    assert.equal(s2.estado?.datos["categoria"], "escombros");
  });

  it("una cantidad vaga pide precisión mencionando el límite", () => {
    const s = simular(flujo, [{ imagen: "foto1" }, { texto: "escombros, un monton" }]);
    assert.equal(s.estado?.paso, "residuo");
    assert.ok(dijo(s.dichos, "5 bolsas"), "el vecino tiene que saber contra qué se mide");
  });

  it("muebles contados por unidad nunca deciden solos", () => {
    const s = simular(flujo, [{ imagen: "foto1" }, { texto: "un sillon y dos sillas" }]);
    assert.equal(s.estado?.paso, "residuo", "pide una referencia de volumen");
  });
});

describe("la acción al exceder la decide la tabla, no el código", () => {
  it("con derivar_sin_ticket corta y ofrece Puntos Verdes", () => {
    // La spec dice retiro parcial con ticket; un borrador dice derivar sin
    // ticket. Es una definición pendiente de Ambiente, así que es configurable.
    const limites = LIMITES_PRUEBA.map((l) =>
      l.categoria === "escombros" ? { ...l, accionAlExceder: "derivar_sin_ticket" as const } : l,
    );
    const ctx = contextoPrueba(catalogoPrueba({ limitesVolumen: limites }));

    const s = simular(flujo, [{ imagen: "foto1" }, { texto: "20 bolsas de escombros" }], ctx);
    assert.equal(s.estado, null, "cerró el flujo");
    assert.equal(s.abandonadoPor, "excede_limite_derivado");
    assert.equal(efectoDe(s.efectos, "crear_ticket"), undefined, "sin ticket");
    assert.ok(dijo(s.dichos, "Lamadrid 3700"), "le da a dónde llevarlo");
  });

  it("si la categoría quedó desactivada en el panel, cierra con cortesía", () => {
    const limites = LIMITES_PRUEBA.map((l) =>
      l.categoria === "poda" ? { ...l, activo: false } : l,
    );
    const ctx = contextoPrueba(catalogoPrueba({ limitesVolumen: limites }));
    const s = simular(flujo, [{ imagen: "foto1" }, { seleccion: "poda" }, { texto: "3 bolsas" }], ctx);
    assert.equal(s.abandonadoPor, "sin_limite_configurado:poda");
  });
});

describe("dirección", () => {
  const hastaDireccion = [{ imagen: "foto1" }, { texto: "3 bolsas de escombros" }];

  it("repregunta si falta la altura, nombrando la calle", () => {
    const s = simular(flujo, [...hastaDireccion, { texto: "Lavalle" }]);
    assert.equal(s.estado?.paso, "direccion");
    assert.ok(dijo(s.dichos, "altura de Lavalle"));
  });

  it("repregunta con un ejemplo si el vecino no sabe la dirección", () => {
    const s = simular(flujo, [...hastaDireccion, { texto: "no se la direccion" }]);
    assert.ok(dijo(s.dichos, "Lavalle al 500"), "da un ejemplo concreto");
  });

  it("acepta calle, altura y entre calles", () => {
    const s = simular(flujo, [
      ...hastaDireccion,
      { texto: "Av. Sarmiento 1200 entre Muñecas y Laprida" },
    ]);
    assert.equal(s.estado, null, "el flujo terminó");
    const ticket = efectoDe(s.efectos, "crear_ticket");
    assert.equal(ticket?.datos.direccion, "Av. Sarmiento 1200, entre Muñecas y Laprida");
  });
});

describe("el ticket que queda", () => {
  function correrCompleto(cantidad: string) {
    return simular(flujo, [
      { imagen: "AgACfoto999" },
      { texto: cantidad },
      { texto: "Lamadrid 50 entre Salta y Corrientes" },
    ]);
  }

  it("registra todo lo capturado", () => {
    const s = correrCompleto("4 bolsas de escombros");
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;

    assert.equal(t.tipo, "Pedido No Habitual");
    assert.equal(t.tipoResiduo, "escombros");
    assert.equal(t.cantidadValor, 4);
    assert.equal(t.cantidadUnidad, "bolsas");
    assert.equal(t.excedeLimite, false);
    assert.equal(t.retiroParcial, false);
    assert.equal(t.fotoReferencia, "AgACfoto999");
    assert.equal(t.diasSinServicio, null);
  });

  it("REGRESIÓN · captura tipo y cantidad, que el bot anterior dejaba vacíos", () => {
    // En las 19 filas heredadas de ManyChat, waste_type y quantity están en
    // null en todas. Por eso aceptó el pedido del árbol caído.
    const s = correrCompleto("9 bolsas de poda");
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.notEqual(t.tipoResiduo, null);
    assert.notEqual(t.cantidadValor, null);
  });

  it("marca el retiro parcial cuando excede", () => {
    const s = correrCompleto("12 bolsas de escombros");
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.excedeLimite, true);
    assert.equal(t.retiroParcial, true);
  });

  it("REGRESIÓN · el vencimiento NO cae en día inhábil", () => {
    // El bot anterior calculaba 72 horas corridas y prometía domingos.
    const s = correrCompleto("3 bolsas de escombros");
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    const sla = configSla(catalogoPrueba());
    assert.equal(esDiaHabil(t.vencimiento, sla), true);
    assert.ok(t.vencimiento > AHORA, "tiene que ser futuro");
  });
});

describe("la confirmación dice la verdad sobre el plazo", () => {
  it("interpola el plazo y la fecha reales, no un texto fijo", () => {
    // El texto sembrado decía literalmente «72 hs hábiles». Con el plazo
    // configurable, un texto fijo puede contradecir el vencimiento del ticket.
    const s = simular(flujo, [
      { imagen: "foto1" },
      { texto: "3 bolsas de escombros" },
      { texto: "Lamadrid 50" },
    ]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    const confirmacion = s.dichos.at(-1)!;

    assert.ok(dijo([confirmacion], "3 días hábiles"), "menciona el plazo calculado");
    assert.ok(
      confirmacion.includes(formatearFechaLocal(t.vencimiento)),
      "y la MISMA fecha que quedó en el ticket",
    );
    assert.ok(dijo([confirmacion], "Transporte 9 de Julio"), "nombra a la empresa");
    assert.doesNotMatch(confirmacion, /\{\w+\}/, "no queda ningún marcador sin reemplazar");
  });

  it("si cambia el modo de plazo, el mensaje cambia con él", () => {
    const config = new Map(catalogoPrueba().configuracion);
    config.set("sla_modo", "horas_corridas");
    const ctx = contextoPrueba(catalogoPrueba({ configuracion: config }));

    const s = simular(
      flujo,
      [{ imagen: "foto1" }, { texto: "3 bolsas de escombros" }, { texto: "Lamadrid 50" }],
      ctx,
    );
    assert.ok(dijo([s.dichos.at(-1)!], "72 horas"), "sigue al modo configurado");
  });
});

describe("el epígrafe de la foto no se tira", () => {
  it("REGRESIÓN · lo que viene escrito sobre la foto se conserva", () => {
    // En Telegram mandar la foto con el texto encima es el caso NORMAL. Este
    // paso recibía `_datos` y descartaba el epígrafe entero, así que el bot
    // volvía a preguntar el tipo y la cantidad que el vecino acababa de dar.
    const s = simular(flujo, [
      { imagen: "foto-ep", texto: "son 4 bolsas de escombros" },
      { texto: "Lamadrid 50" },
    ]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.tipoResiduo, "escombros");
    assert.equal(t.cantidadValor, 4);
    assert.equal(t.direccion, "Lamadrid 50");
    assert.equal(t.fotoReferencia, "foto-ep");
  });

  it("el epígrafe sobrevive aunque la foto llegue en otro turno", () => {
    const s = simular(flujo, [
      { texto: "son 4 bolsas de escombros" },
      { imagen: "foto-ep2" },
      { texto: "Lamadrid 50" },
    ]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.tipoResiduo, "escombros");
    assert.equal(t.cantidadValor, 4);
  });

  it("REGRESIÓN · al pedir el tipo no se pierde la cantidad", () => {
    // La rama simétrica de la que ya estaba resuelta en el paso de precisión.
    const s = simular(flujo, [{ imagen: "f" }, { texto: "tengo 4 bolsas" }, { texto: "escombros" }]);
    assert.equal(s.estado?.paso, "direccion", "no vuelve a pedir la cantidad");
    assert.equal(s.estado?.datos["cantidadValor"], 4);
  });

  it("una precisión nueva le gana a una frase vaga anterior", () => {
    // Acumular a ciegas hacía que «no sé cuántas» siguiera ganando después de
    // que el vecino dijera «8».
    const s = simular(flujo, [
      { imagen: "f" },
      { texto: "tengo escombros pero no se cuantas bolsas" },
      { texto: "8" },
    ]);
    assert.equal(s.estado?.paso, "direccion");
  });
});
