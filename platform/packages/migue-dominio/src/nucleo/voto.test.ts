/**
 * El voto del vecino: ¿le sirvió la respuesta?
 *
 * Estas pruebas existen porque el camino del seguimiento NO estaba cubierto por
 * ninguna. Se cambió el mensaje «¿te sirvió?» de texto suelto a dos botones y
 * los 360 tests siguieron verdes — el fixture del catálogo no tenía la clave
 * `seguimiento_tras_responder`, así que el bloque entero nunca se ejecutaba en
 * la suite. Un cambio de comportamiento visible para el vecino pasó sin que
 * nada lo notara.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { procesarMensaje } from "./orquestador.ts";
import { puertosPrueba, type OpcionesPuertos } from "./_puertos.ts";
import { AHORA, catalogoPrueba } from "../flujos/_fixtures.ts";
import { opcionesDeVoto, OPCIONES_VALORACION, votoDe } from "../flujos/opciones.ts";
import type { MensajeEntrante } from "../mensajeria.ts";

const USUARIO = "555";

function msg(parcial: Partial<MensajeEntrante> = {}): MensajeEntrante {
  return {
    canal: "telegram",
    canalUsuarioId: USUARIO,
    nombreUsuario: "Vecino Prueba",
    texto: null,
    media: null,
    seleccion: null,
    recibidoEn: AHORA,
    ...parcial,
  };
}

async function conversar(
  turnos: readonly Partial<MensajeEntrante>[],
  opciones: OpcionesPuertos = {},
) {
  const puertos = puertosPrueba(opciones);
  const resultados = [];
  for (const turno of turnos) {
    resultados.push(await procesarMensaje(msg(turno), puertos));
  }
  return { puertos, resultados, ultimo: resultados.at(-1)! };
}

/** Una respuesta real del buscador, que es lo que dispara el pedido de voto. */
const RESPONDIO: OpcionesPuertos = {
  intencion: "consulta_libre",
  respuesta: {
    tipo: "sintetizada",
    texto: "Los residuos verdes se retiran los martes y viernes.",
    coincidencias: [
      {
        origen: "faq",
        id: "f1",
        titulo: "Poda",
        texto: "Los residuos verdes se retiran los martes y viernes.",
        documentoTitulo: null,
        pagina: null,
        rank: 0.9,
        difuso: false,
      },
    ],
    traza: {
      modelo: "prueba",
      tokensEntrada: 10,
      tokensSalida: 5,
      costoUsd: 0.0001,
      latenciaMs: 100,
      consultaExpandida: null,
      confianza: 0.9,
    },
  },
};

// ---------------------------------------------------------------------------
// Reconocer el voto
// ---------------------------------------------------------------------------

describe("votoDe", () => {
  /** Sólo el voto, para las pruebas a las que no les importa el referente. */
  const soloVoto = (e: Parameters<typeof votoDe>[0]) => votoDe(e)?.voto ?? null;

  it("reconoce el toque de cada botón", () => {
    assert.equal(soloVoto({ seleccion: "voto_util" }), "util");
    assert.equal(soloVoto({ seleccion: "voto_no_util" }), "no_util");
  });

  // EL ARREGLO DEL BUG BLOQUEANTE. El botón lleva el id del mensaje que se
  // está valorando, así que no hay nada que inferir. Antes la base buscaba «el
  // último saliente con origen_respuesta no nulo» y eso era SIEMPRE el propio
  // «¿te sirvió?», porque `responderCon` le ponía la columna a los dos.
  it("extrae el mensaje valorado del id del botón", () => {
    const r = votoDe({ seleccion: "voto_util:11111111-2222-3333-4444-555555555555" });
    assert.deepEqual(r, { voto: "util", mensajeId: "11111111-2222-3333-4444-555555555555" });

    const n = votoDe({ seleccion: "voto_no_util:abc-def" });
    assert.deepEqual(n, { voto: "no_util", mensajeId: "abc-def" });
  });

  // Un teclado de antes de este cambio sigue funcionando: el voto se registra y
  // la base cae a su respaldo. Peor que exacto, mejor que perderlo.
  it("un botón viejo sin referente sigue votando, con mensajeId null", () => {
    assert.deepEqual(votoDe({ seleccion: "voto_util" }), { voto: "util", mensajeId: null });
  });

  it("un id con dos puntos y nada atrás no inventa un mensaje", () => {
    assert.deepEqual(votoDe({ seleccion: "voto_util:" }), { voto: "util", mensajeId: null });
  });

  it("acepta el emoji suelto, que hay gente que lo manda en vez de tocar", () => {
    assert.equal(soloVoto({ texto: "👍" }), "util");
    assert.equal(soloVoto({ texto: "👎" }), "no_util");
  });

  // El pulgar con tono de piel es un emoji DISTINTO: `👍` más un modificador
  // U+1F3FB..U+1F3FF. Sin normalizarlo, un vecino que usa su tono manda un voto
  // que no se registra, y el mensaje sigue de largo hasta el clasificador: se
  // paga una llamada al modelo y recibe un «no entendí» por haber usado el mismo
  // emoji que el bot le ofreció.
  it("acepta el pulgar con cualquier tono de piel", () => {
    for (const tono of ["🏻", "🏼", "🏽", "🏾", "🏿"]) {
      assert.equal(soloVoto({ texto: `👍${tono}` }), "util", `👍${tono}`);
      assert.equal(soloVoto({ texto: `👎${tono}` }), "no_util", `👎${tono}`);
    }
  });

  it("acepta el pulgar con selector de variación, que algunos teclados agregan", () => {
    assert.equal(soloVoto({ texto: "👍\uFE0F" }), "util");
  });

  it("acepta la etiqueta escrita tal cual", () => {
    assert.equal(soloVoto({ texto: OPCIONES_VALORACION[0]!.etiqueta }), "util");
    assert.equal(soloVoto({ texto: OPCIONES_VALORACION[1]!.etiqueta }), "no_util");
  });

  // ESTE es el caso que justifica que `votoDe` no use `resolverOpcion`. El bot
  // no lleva registro de que acaba de ofrecer el voto, así que un «1» suelto es
  // mucho más probable que sea la primera opción del MENÚ. Leerlo como pulgar
  // arriba registraría una medición falsa y, peor, no arrancaría el flujo que el
  // vecino pidió: se quedaría esperando.
  it("NO toma un número suelto como voto", () => {
    assert.equal(soloVoto({ texto: "1" }), null);
    assert.equal(soloVoto({ texto: "2" }), null);
    assert.equal(soloVoto({ texto: "opcion 1" }), null);
  });

  it("no confunde una consulta que menciona algo parecido", () => {
    assert.equal(soloVoto({ texto: "no me sirvió para nada lo que dijiste antes" }), null);
    assert.equal(soloVoto({ texto: "si me sirvio gracias" }), null);
    assert.equal(soloVoto({ texto: "" }), null);
    assert.equal(soloVoto({}), null);
  });
});

// ---------------------------------------------------------------------------
// El pedido de voto
// ---------------------------------------------------------------------------

describe("después de responder, Migue pide el voto", () => {
  it("manda la pregunta como mensaje aparte, con los dos botones", async () => {
    const { puertos } = await conversar([{ texto: "cuándo pasa el camión de poda" }], RESPONDIO);

    // Dos salientes: la respuesta y el pedido de voto. Que sean dos y no uno es
    // deliberado: la respuesta se tiene que poder reenviar sin arrastrar una
    // pregunta de cortesía.
    assert.equal(puertos.registro.salientes.length, 2);

    const respuesta = puertos.registro.salientes[0]!;
    const pedido = puertos.registro.salientes[1]!;
    assert.match(pedido.texto, /sirvió/i);
    // Los ids llevan pegado el id de la RESPUESTA. Esta aserción decía
    // `["voto_util", "voto_no_util"]` y pasaba mientras el voto se colgaba del
    // mensaje equivocado: sin el referente no había nada en el botón que dijera
    // qué se estaba valorando, y la base lo adivinaba mal.
    assert.deepEqual(
      pedido.opciones.map((o) => o.id),
      [`voto_util:${respuesta.id}`, `voto_no_util:${respuesta.id}`],
    );
  });

  // Tras un «no tengo esa información», preguntar si sirvió es sal en la herida.
  // Y el voto no agregaría nada: esa falla ya quedó en `sin_respuesta`.
  it("NO pide el voto cuando no supo responder", async () => {
    const { puertos } = await conversar([{ texto: "algo rarísimo" }], {
      intencion: "consulta_libre",
      respuesta: {
        tipo: "sin_respuesta",
        texto: "No tengo esa información.",
        motivo: "sin_coincidencia",
        traza: {
          modelo: "prueba",
          tokensEntrada: 10,
          tokensSalida: 5,
          costoUsd: 0,
          latenciaMs: 10,
          consultaExpandida: null,
          confianza: 0.1,
        },
      },
    });

    assert.equal(puertos.registro.salientes.length, 1);
    assert.equal(puertos.registro.salientes[0]?.opciones.length, 0);
    // Y sí quedó registrada como pregunta sin responder.
    assert.equal(puertos.registro.sinRespuesta.length, 1);
  });

  // Vaciar el texto desde el panel apaga el voto sin necesidad de un deploy. Es
  // la única forma de desactivarlo si al área le resulta molesto.
  it("vaciar el texto desde el panel apaga el pedido de voto", async () => {
    const textos = new Map(catalogoPrueba().textos);
    textos.set("seguimiento_tras_responder", "   ");

    const { puertos } = await conversar([{ texto: "cuándo pasa el camión" }], {
      ...RESPONDIO,
      catalogo: catalogoPrueba({ textos }),
    });

    assert.equal(puertos.registro.salientes.length, 1, "no debería pedir el voto");
  });
});

// ---------------------------------------------------------------------------
// Registrar el voto
// ---------------------------------------------------------------------------

describe("cuando el vecino vota", () => {
  it("un pulgar arriba se registra y Migue agradece", async () => {
    const { puertos } = await conversar([{ seleccion: "voto_util" }]);

    assert.deepEqual(puertos.registro.votos, [{ voto: "util", mensajeId: null }]);
    assert.match(puertos.registro.salientes.at(-1)!.texto, /Buenísimo/i);
  });

  it("un pulgar abajo se registra y Migue pregunta qué faltó", async () => {
    const { puertos } = await conversar([{ seleccion: "voto_no_util" }]);

    assert.deepEqual(puertos.registro.votos, [{ voto: "no_util", mensajeId: null }]);
    assert.match(puertos.registro.salientes.at(-1)!.texto, /Qué te falta saber/i);
  });

  it("el voto no llama al clasificador: no hay nada que adivinar", async () => {
    const { ultimo } = await conversar([{ seleccion: "voto_util" }]);
    // Si hubiera pasado por el clasificador, la traza traería tokens.
    assert.equal(ultimo.origenRespuesta, "flujo");
  });

  it("votar no abre ni cierra ninguna conversación", async () => {
    const { puertos } = await conversar([{ seleccion: "voto_util" }]);
    assert.deepEqual(puertos.registro.cierres, []);
  });

  // ---------------------------------------------------------------------------
  // EL CASO QUE MOTIVÓ EL ORDEN DEL ORQUESTADOR
  // ---------------------------------------------------------------------------
  // Telegram deja los teclados en línea viejos VIVOS para siempre. El vecino
  // puede recibir una respuesta con los botones de pulgar, después arrancar un
  // pedido de retiro, y recién entonces subir en el historial y tocar el pulgar.
  //
  // Si el voto se manejara después del flujo activo, ese toque entraría como
  // respuesta al paso actual —«voto_util» como dirección— y el vecino recibiría
  // un «no entendí» por haber usado un botón que el bot mismo le ofreció.
  it("un voto en medio de un flujo se registra SIN romper el flujo", async () => {
    const { puertos, ultimo } = await conversar(
      [
        { texto: "necesito que retiren escombros" },
        { seleccion: "voto_util" },
      ],
      { intencion: "retiro_no_habitual", confianza: 0.95 },
    );

    assert.deepEqual(puertos.registro.votos, [{ voto: "util", mensajeId: null }]);

    // El flujo sigue vivo: ni el estado se borró ni el paso avanzó.
    assert.equal(ultimo.flujoActivo, "retiro_no_habitual");
    assert.equal(puertos.almacen.tamano(), 1, "el estado del flujo se perdió");

    // Y no se le contestó con un «no entendí» del paso.
    assert.match(puertos.registro.salientes.at(-1)!.texto, /Buenísimo/i);
  });

  it("después del voto, el flujo continúa donde estaba", async () => {
    const { puertos, ultimo } = await conversar(
      [
        { texto: "necesito que retiren escombros" },
        { seleccion: "voto_no_util" },
        { texto: "Lamadrid 250" },
      ],
      { intencion: "retiro_no_habitual", confianza: 0.95 },
    );

    // El tercer turno lo atendió el FLUJO, no el clasificador: si el voto
    // hubiera borrado el estado, «Lamadrid 250» habría ido al router.
    assert.equal(ultimo.origenRespuesta, "flujo");
    assert.equal(ultimo.flujoActivo, "retiro_no_habitual");
    assert.deepEqual(puertos.registro.votos, [{ voto: "no_util", mensajeId: null }]);
  });
});

// ---------------------------------------------------------------------------
// El comentario
// ---------------------------------------------------------------------------

describe("el comentario que explica un pulgar abajo", () => {
  it("todo texto se ofrece como posible explicación, y la base decide", async () => {
    const { puertos } = await conversar(
      [{ seleccion: "voto_no_util" }, { texto: "yo pregunté por escombros no por poda" }],
      RESPONDIO,
    );

    assert.ok(
      puertos.registro.comentariosIntentados.includes("yo pregunté por escombros no por poda"),
      "no se ofreció el texto como explicación del voto",
    );
  });

  // Lo importante: guardar el comentario NO consume el mensaje. «Yo pregunté por
  // escombros, no por poda» es a la vez la explicación del voto Y una consulta
  // nueva. Contestar sólo «gracias» dejaría al vecino sin respuesta por segunda
  // vez, que es exactamente lo que se estaba midiendo.
  it("el mensaje se sigue contestando como consulta", async () => {
    const { puertos } = await conversar(
      [{ seleccion: "voto_no_util" }, { texto: "y los escombros cuándo los retiran" }],
      RESPONDIO,
    );

    const ultimos = puertos.registro.salientes.slice(-2).map((s) => s.texto);
    assert.ok(
      ultimos.some((t) => /residuos verdes se retiran/.test(t)),
      "el vecino no recibió respuesta a su consulta: " + JSON.stringify(ultimos),
    );
  });

  it("un mensaje sin texto no intenta comentar nada", async () => {
    const { puertos } = await conversar([{ seleccion: "voto_no_util" }]);
    assert.deepEqual(puertos.registro.comentariosIntentados, []);
  });

  it("un toque de botón tampoco se ofrece como comentario", async () => {
    // Si el voto se ofreciera a sí mismo como comentario, un vecino que corrige
    // su voto tocando el otro botón dejaría «voto_util» escrito como
    // explicación en la tabla.
    const { puertos } = await conversar([
      { seleccion: "voto_no_util" },
      { seleccion: "voto_util" },
    ]);
    assert.deepEqual(puertos.registro.comentariosIntentados, []);
    assert.deepEqual(puertos.registro.votos, [
      { voto: "no_util", mensajeId: null },
      { voto: "util", mensajeId: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// El referente del voto
// ---------------------------------------------------------------------------

describe("los botones de voto llevan el mensaje que se valora", () => {
  // ESTA es la prueba del bug bloqueante. Antes los botones tenían ids fijos y
  // la base resolvía por inferencia, colgando el 100% de los votos de la propia
  // pregunta «¿te sirvió?».
  it("el id del botón apunta a la RESPUESTA, no al «¿te sirvió?»", async () => {
    const { puertos } = await conversar([{ texto: "cuándo pasa el camión de poda" }], RESPONDIO);

    const [respuesta, pedido] = puertos.registro.salientes;
    assert.ok(respuesta && pedido, "tienen que ser dos salientes");

    // El pedido de voto ofrece dos botones, y los dos referencian el id del
    // saliente 0 — la respuesta.
    assert.deepEqual(
      pedido.opciones.map((o) => o.id),
      [`voto_util:${respuesta.id}`, `voto_no_util:${respuesta.id}`],
    );

    // Y NO al suyo propio, que es el error que se estaba cometiendo.
    for (const o of pedido.opciones) {
      assert.ok(
        !o.id.endsWith(pedido.id),
        `el botón «${o.id}» apunta al propio «¿te sirvió?» en vez de a la respuesta`,
      );
    }
  });

  // El otro medio del arreglo: el «¿te sirvió?» no lleva origen, así que el
  // respaldo de la base —para el emoji suelto y los teclados viejos— también
  // apunta a la respuesta.
  it("el «¿te sirvió?» no lleva origen_respuesta: es cortesía, no respuesta", async () => {
    const { puertos } = await conversar([{ texto: "cuándo pasa el camión de poda" }], RESPONDIO);
    const [respuesta, pedido] = puertos.registro.salientes;
    assert.equal(respuesta!.traza.origenRespuesta, "faq");
    assert.equal(
      pedido!.traza.origenRespuesta,
      null,
      "con origen no nulo, el respaldo de la base vuelve a elegir la cortesía",
    );
  });

  it("el voto llega a la base con el mensaje que traía el botón", async () => {
    const { puertos } = await conversar(
      [{ seleccion: "voto_no_util:11111111-2222-3333-4444-555555555555" }],
    );
    assert.deepEqual(puertos.registro.votos, [
      { voto: "no_util", mensajeId: "11111111-2222-3333-4444-555555555555" },
    ]);
  });

  // Los botones que NO son de voto no se tocan: `resolverOpcion` compara el id
  // exacto, así que un sufijo rompería el menú y las categorías de un trámite.
  it("no le pega el referente a los botones que no son de voto", async () => {
    const { puertos } = await conversar([{ texto: "hola" }]);
    for (const s of puertos.registro.salientes) {
      for (const o of s.opciones) {
        if (!o.id.startsWith("voto_")) {
          assert.ok(!o.id.includes(":"), `el id «${o.id}» quedó con un sufijo y no debería`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Qué se guarda como explicación del pulgar abajo
// ---------------------------------------------------------------------------

describe("el comentario del voto no captura cualquier cosa", () => {
  // `textoEfectivo()` devuelve `seleccion ?? texto`, así que un toque de botón
  // dejaba el ID INTERNO guardado como lo que dijo el vecino:
  // «retiro_no_habitual» aparecía en la lista de conversaciones como su
  // explicación.
  it("un toque de botón no se guarda como explicación", async () => {
    const { puertos } = await conversar([{ seleccion: "retiro_no_habitual" }]);
    assert.deepEqual(
      puertos.registro.comentariosIntentados,
      [],
      "el id interno de una opción no es algo que el vecino haya dicho",
    );
  });

  // Con un trámite abierto el texto es la respuesta a un paso. Se guardaba
  // «Lamadrid 550» como el motivo por el que la respuesta no sirvió: además de
  // mentir, copiaba la dirección de un vecino a una tabla que no es la del
  // pedido, y de ahí a la LISTA de conversaciones del panel.
  it("un paso de un trámite abierto no se guarda como explicación", async () => {
    // La intención va explícita: sin ella el clasificador de prueba no arranca
    // ningún flujo, `estadoPrevio` queda en null en los cuatro turnos, y la
    // prueba pasaría sin ejercitar la guarda que dice estar probando. Ya me
    // pasó: la primera versión de este test daba verde por eso.
    const { puertos } = await conversar(
      [
        { texto: "necesito que retiren escombros" },
        { texto: "escombros" },
        { media: { tipo: "imagen", referencia: "foto-1" } },
        { texto: "Lamadrid 550" },
      ],
      { intencion: "retiro_no_habitual" },
    );

    // Primero: que el flujo haya arrancado de verdad. Si no, lo de abajo no
    // prueba nada.
    assert.ok(
      puertos.registro.flujosGuardados.length > 0,
      "el flujo no arrancó: la prueba no está ejercitando la guarda",
    );

    assert.ok(
      !puertos.registro.comentariosIntentados.includes("Lamadrid 550"),
      "la dirección del vecino no puede terminar en valoraciones.comentario",
    );
  });

  // Y lo que SÍ tiene que capturar: texto libre, sin trámite abierto.
  it("una explicación escrita sí se intenta guardar", async () => {
    const { puertos } = await conversar(
      [{ texto: "yo pregunte por escombros no por poda" }],
      RESPONDIO,
    );
    assert.ok(
      puertos.registro.comentariosIntentados.includes("yo pregunte por escombros no por poda"),
    );
  });
});

// ---------------------------------------------------------------------------
// Cuando el voto no se pudo guardar
// ---------------------------------------------------------------------------

describe("si el voto no se pudo guardar, Migue no agradece", () => {
  // Confirmarle «¡Buenísimo!» a alguien cuyo voto se perdió lo deja creyendo
  // que se registró, y para el área es una medición perdida sin ningún síntoma.
  it("no manda el acuse cuando la base no registró nada", async () => {
    const puertos = puertosPrueba();
    // El voto no se puede registrar: pasa si el vecino toca un botón de una
    // conversación que ya se cerró.
    puertos.persistencia.registrarVoto = async () => null;

    const r = await procesarMensaje(msg({ seleccion: "voto_util" }), puertos);
    assert.equal(
      r.salientes.length,
      0,
      "no hay que agradecer un voto que no se guardó",
    );
  });

  it("y sí lo manda cuando se registró", async () => {
    const { ultimo } = await conversar([{ seleccion: "voto_util" }]);
    assert.equal(ultimo.salientes.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Los límites de los canales
// ---------------------------------------------------------------------------

describe("los botones de voto entran en los límites de cada canal", () => {
  // El renderizador de Telegram DESCARTA en silencio cualquier opción cuyo id
  // pase los 64 bytes de `callback_data`. Si un día no entrara, los pulgares
  // desaparecerían del mensaje sin ningún error, en ningún log: el vecino
  // recibiría la pregunta «¿te sirvió?» sin nada que tocar.
  it("el callback_data de Telegram admite 64 bytes y el id más largo entra", () => {
    const [util, noUtil] = opcionesDeVoto("11111111-2222-3333-4444-555555555555");
    for (const o of [util!, noUtil!]) {
      const bytes = new TextEncoder().encode(o.id).length;
      assert.ok(bytes <= 64, `«${o.id}» son ${bytes} bytes y Telegram admite 64`);
    }
  });

  // WhatsApp Cloud API: 20 caracteres por etiqueta de botón de respuesta
  // rápida, y hasta 3 botones. Son dos etiquetas y las dos tienen emoji, que
  // cuenta como un carácter y no como sus bytes.
  it("las etiquetas entran en los 20 caracteres de WhatsApp", () => {
    for (const o of OPCIONES_VALORACION) {
      const largo = [...o.etiqueta].length;
      assert.ok(largo <= 20, `«${o.etiqueta}» tiene ${largo} caracteres y WhatsApp admite 20`);
    }
    assert.ok(OPCIONES_VALORACION.length <= 3, "WhatsApp admite 3 botones");
  });

  it("sin mensaje que valorar, los ids quedan sin sufijo", () => {
    assert.deepEqual(
      opcionesDeVoto(null).map((o) => o.id),
      ["voto_util", "voto_no_util"],
    );
  });
});
