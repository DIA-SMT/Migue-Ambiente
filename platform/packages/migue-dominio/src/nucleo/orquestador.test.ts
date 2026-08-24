import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { procesarMensaje, claveDeEstado } from "./orquestador.ts";
import { dicho, puertosPrueba, type OpcionesPuertos } from "./_puertos.ts";
import { AHORA, catalogoPrueba } from "../flujos/_fixtures.ts";
import type { MensajeEntrante } from "../mensajeria.ts";
import { OPCIONES_MENU } from "../flujos/opciones.ts";

const USUARIO = "555";
const CLAVE = claveDeEstado("telegram", USUARIO);

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

/** Corre varios turnos contra los mismos puertos. */
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

describe("saludos y despedidas", () => {
  it("un saludo devuelve la bienvenida y no abre ningún flujo", async () => {
    const { puertos, ultimo } = await conversar([{ texto: "hola" }], { intencion: "saludo" });
    assert.match(dicho(puertos), /Migue Ambiente/);
    assert.equal(ultimo.flujoActivo, null);
    assert.equal(puertos.almacen.tamano(), 0, "no debería guardar estado");
  });

  it("una despedida cierra la conversación", async () => {
    const { puertos } = await conversar([{ texto: "gracias" }], { intencion: "despedida" });
    assert.deepEqual(puertos.registro.cierres, ["cerrada"]);
  });
});

describe("arranque de flujo", () => {
  it("un pedido claro arranca el flujo y guarda el estado", async () => {
    const { puertos, ultimo } = await conversar(
      [{ texto: "necesito que retiren escombros" }],
      { intencion: "retiro_no_habitual", confianza: 0.95 },
    );

    assert.equal(ultimo.flujoActivo, "retiro_no_habitual");
    assert.equal(ultimo.origenRespuesta, "flujo");
    assert.ok(await puertos.almacen.leer(CLAVE), "el estado quedó guardado");
    // La apertura del flujo A manda dos mensajes: requisitos y pedido de foto.
    assert.equal(puertos.registro.salientes.length, 2);
    assert.match(dicho(puertos), /Regla de Oro/);
  });

  it("guarda el paso en la conversación, para que el panel lo vea", async () => {
    const { puertos } = await conversar([{ texto: "retiren escombros" }], {
      intencion: "retiro_no_habitual",
      confianza: 0.95,
    });
    assert.deepEqual(puertos.registro.flujosGuardados, [
      { flujo: "retiro_no_habitual", paso: "foto" },
    ]);
  });

  it("con confianza baja NO arranca el flujo: intenta responder", async () => {
    const { ultimo } = await conversar([{ texto: "algo de escombros?" }], {
      intencion: "retiro_no_habitual",
      confianza: 0.2,
    });
    assert.equal(ultimo.flujoActivo, null);
    assert.equal(ultimo.origenRespuesta, "faq", "fue a la cadena de conocimiento");
  });
});

describe("continuidad del flujo", () => {
  const arranque = { intencion: "retiro_no_habitual" as const, confianza: 0.95 };

  it("una conversación completa genera el ticket", async () => {
    const { puertos, ultimo } = await conversar(
      [
        { texto: "necesito que retiren escombros" },
        { media: { tipo: "imagen", referencia: "foto-abc" } },
        { texto: "4 bolsas de escombros" },
        { texto: "Lamadrid 50 entre Salta y Corrientes" },
      ],
      arranque,
    );

    const ticket = puertos.registro.efectos.find((e) => e.tipo === "crear_ticket");
    assert.ok(ticket, `no se creó el ticket. Dicho: ${dicho(puertos)}`);
    if (ticket?.tipo !== "crear_ticket") return;

    assert.equal(ticket.datos.tipoResiduo, "escombros");
    assert.equal(ticket.datos.cantidadValor, 4);
    assert.equal(ticket.datos.fotoReferencia, "foto-abc");
    assert.equal(ticket.datos.direccion, "Lamadrid 50, entre Salta y Corrientes");

    assert.equal(ultimo.flujoActivo, null, "el flujo terminó");
    assert.equal(puertos.almacen.tamano(), 0, "el estado se limpió");
    assert.match(dicho(puertos), /Solicitud registrada/);
  });

  it("el clasificador NO se llama mientras hay un flujo activo", async () => {
    // Si se llamara, un «4 bolsas» en medio del flujo se clasificaría como
    // consulta y rompería la conversación. Y sería pagar por una llamada que
    // no cambia nada.
    let llamadas = 0;
    const puertos = puertosPrueba(arranque);
    const original = puertos.clasificar;
    const espiado = {
      ...puertos,
      clasificar: async (t: string, c: Parameters<typeof original>[1]) => {
        llamadas++;
        return original(t, c);
      },
    };

    await procesarMensaje(msg({ texto: "retiren escombros" }), espiado);
    assert.equal(llamadas, 1, "el primer mensaje sí se clasifica");

    await procesarMensaje(msg({ media: { tipo: "imagen", referencia: "f" } }), espiado);
    await procesarMensaje(msg({ texto: "3 bolsas de escombros" }), espiado);
    assert.equal(llamadas, 1, "los mensajes del flujo no se clasifican");
  });

  it("«cancelar» corta el flujo en cualquier paso", async () => {
    const { puertos, ultimo } = await conversar(
      [
        { texto: "necesito que retiren escombros" },
        { media: { tipo: "imagen", referencia: "f" } },
        { texto: "cancelar" },
      ],
      arranque,
    );
    assert.equal(ultimo.flujoActivo, null);
    assert.equal(puertos.almacen.tamano(), 0);
    assert.match(dicho(puertos), /cancelé/i);
    assert.equal(
      puertos.registro.efectos.some((e) => e.tipo === "crear_ticket"),
      false,
      "no debe crear ticket a medias",
    );
  });

  it("un flujo guardado que ya no existe en el código no atasca al vecino", async () => {
    // Pasa si se renombra un flujo entre deploys y quedan estados viejos en
    // Redis. Sin este rescate, esos vecinos quedan sin poder hacer nada.
    const puertos = puertosPrueba({ intencion: "consulta_libre" });
    await puertos.almacen.guardar(CLAVE, {
      flujo: "flujo_que_ya_no_existe" as never,
      paso: "algo",
      datos: {},
      intentos: 0,
      iniciadoEn: AHORA.toISOString(),
    });

    const r = await procesarMensaje(msg({ texto: "donde hay un punto verde" }), puertos);
    assert.equal(puertos.almacen.tamano(), 0, "el estado inválido se descartó");
    assert.equal(r.origenRespuesta, "faq", "y el mensaje se atendió normalmente");
  });
});

describe("exclusiones", () => {
  it("un olor a gas se deriva sin más preguntas", async () => {
    const { puertos, ultimo } = await conversar([{ texto: "hay olor a gas en mi cuadra" }]);
    assert.equal(ultimo.origenRespuesta, "exclusion");
    assert.match(dicho(puertos), /alejate del lugar/i);
    assert.deepEqual(puertos.registro.cierres, ["derivada"]);
  });

  it("REGRESIÓN · el gas interrumpe incluso un flujo en curso", async () => {
    // Si un vecino escribe «hay olor a gas» mientras carga un pedido de
    // escombros, corresponde derivarlo ya. Terminar de preguntarle cuántas
    // bolsas tiene sería absurdo, y por eso la regla de gas tiene la prioridad
    // más alta de la tabla.
    const { puertos, ultimo } = await conversar(
      [
        { texto: "necesito que retiren escombros" },
        { texto: "esperá, hay olor a gas acá" },
      ],
      { intencion: "retiro_no_habitual", confianza: 0.95 },
    );

    assert.equal(ultimo.origenRespuesta, "exclusion");
    assert.equal(puertos.almacen.tamano(), 0, "el flujo se abandonó");
    assert.match(dicho(puertos), /Naturgy|Gasnor|alejate/i);
  });

  it("se puede apagar la interrupción de flujos desde el panel", async () => {
    // Una palabra genérica cargada por error podría interrumpir flujos
    // legítimos. La salida no es un deploy, es una fila de configuración.
    const config = new Map(catalogoPrueba().configuracion);
    config.set("exclusiones_durante_flujo", false);

    const { puertos, ultimo } = await conversar(
      [
        { texto: "necesito que retiren escombros" },
        { texto: "esperá, hay olor a gas acá" },
      ],
      {
        intencion: "retiro_no_habitual",
        confianza: 0.95,
        catalogo: catalogoPrueba({ configuracion: config }),
      },
    );

    assert.notEqual(ultimo.origenRespuesta, "exclusion");
    assert.ok(puertos.almacen.tamano() > 0, "el flujo sigue vivo");
  });

  it("una consulta legítima NO se deriva", async () => {
    const { ultimo } = await conversar([{ texto: "cuanto gasto si contrato un contenedor" }]);
    assert.notEqual(ultimo.origenRespuesta, "exclusion");
  });
});

describe("cadena de conocimiento", () => {
  it("una consulta libre se responde y se cita la fuente", async () => {
    const { puertos, ultimo } = await conversar([{ texto: "donde llevo los reciclables" }]);
    assert.equal(ultimo.origenRespuesta, "faq");
    assert.match(dicho(puertos), /Puntos Verdes/);
    assert.deepEqual(puertos.registro.salientes[0]?.traza.fragmentosCitados, ["faq-1"]);
  });

  it("lo que no se pudo responder queda registrado", async () => {
    // Es la tabla que alimenta el circuito de mejora del panel.
    const { puertos } = await conversar([{ texto: "cuanto sale el registro de conducir" }], {
      respuesta: {
        tipo: "sin_respuesta",
        texto: "No tengo esa información.",
        motivo: "sin_coincidencia",
        traza: {
          modelo: null,
          tokensEntrada: 0,
          tokensSalida: 0,
          costoUsd: null,
          latenciaMs: 0,
          consultaExpandida: null,
          confianza: 0.2,
        },
      },
    });

    assert.equal(puertos.registro.sinRespuesta.length, 1);
    assert.equal(puertos.registro.sinRespuesta[0]?.motivo, "sin_coincidencia");
    assert.match(puertos.registro.sinRespuesta[0]!.pregunta, /registro de conducir/);
  });

  it("suma el costo del router al de la síntesis", async () => {
    // El router corre en CADA mensaje. Si su costo no se suma, las métricas
    // del panel subestiman lo que sale operar el bot.
    const { puertos } = await conversar([{ texto: "donde hay puntos verdes" }]);
    const traza = puertos.registro.salientes[0]!.traza;
    assert.equal(traza.tokensEntrada, 200, "100 del router + 100 de la síntesis");
    assert.equal(traza.costoUsd, 0.0002);
  });
});

describe("casos borde", () => {
  it("una foto sin contexto pregunta qué necesita", async () => {
    // Pasa seguido: la gente saca la foto primero. Mandarle «no entendí» a un
    // intento válido es peor que preguntarle.
    const { puertos, ultimo } = await conversar([
      { media: { tipo: "imagen", referencia: "foto-sola" } },
    ]);
    assert.equal(ultimo.origenRespuesta, "fallback");
    assert.match(dicho(puertos), /Recibí la foto/);
  });

  it("lo no entendido muestra el menú, y sólo eso", async () => {
    const { puertos, ultimo } = await conversar([{ texto: "asdkjh" }], {
      intencion: "no_entendido",
    });
    assert.equal(ultimo.origenRespuesta, "fallback");
    assert.match(dicho(puertos), /Retiro de residuos especiales/);
  });

  it("la traza va sólo en el primer mensaje del turno", async () => {
    // La apertura del flujo A manda dos mensajes. Repetir tokens y costo en
    // cada uno multiplicaría las métricas por la cantidad de mensajes.
    const { puertos } = await conversar([{ texto: "retiren escombros" }], {
      intencion: "retiro_no_habitual",
      confianza: 0.95,
    });
    assert.equal(puertos.registro.salientes.length, 2);
    assert.equal(puertos.registro.salientes[0]?.traza.tokensEntrada, 100);
    assert.equal(puertos.registro.salientes[1]?.traza.tokensEntrada, undefined);
  });

  it("todo mensaje entrante se registra, incluso los derivados", async () => {
    const { puertos } = await conversar([
      { texto: "hola" },
      { texto: "hay olor a gas" },
      { texto: "donde hay puntos verdes" },
    ]);
    assert.equal(puertos.registro.entrantes, 3);
  });

  it("dos canales del mismo usuario no comparten estado", async () => {
    // La clave incluye el canal. Sin eso, un flujo abierto en Telegram
    // respondería a mensajes de WhatsApp.
    const puertos = puertosPrueba({ intencion: "retiro_no_habitual", confianza: 0.95 });
    await procesarMensaje(msg({ texto: "retiren escombros" }), puertos);
    assert.ok(await puertos.almacen.leer(claveDeEstado("telegram", USUARIO)));
    assert.equal(await puertos.almacen.leer(claveDeEstado("whatsapp", USUARIO)), null);
  });
});

describe("elegir del menú escribiendo el número", () => {
  // Sin intención forzada: estos casos se resuelven sin clasificador, o con el
  // clasificador de prueba por defecto.
  const sinForzar: OpcionesPuertos = {};
  // El caso reportado al probar el bot: Migue muestra el menú numerado, el
  // vecino contesta «1», y no pasaba nada. El clasificador veía «1», no
  // entendía, y el bot volvía a mostrar el menú. El vecino repetía el número
  // creyendo que no llegaba.

  it("el menú se manda CON opciones, no como texto suelto", async () => {
    // Sin opciones no hay botones en Telegram y no hay nada que resolver cuando
    // el vecino escribe el número.
    const { puertos } = await conversar([{ texto: "asdkjhasd" }], {
      intencion: "no_entendido",
      confianza: 0.9,
    });
    const conOpciones = puertos.registro.salientes.find((s) => s.opciones.length > 0);
    assert.ok(conOpciones, `el menú salió sin opciones. Dicho: ${dicho(puertos)}`);
    assert.equal(conOpciones.opciones.length, OPCIONES_MENU.length);
    // Se comparan contra OPCIONES_MENU y no contra una lista escrita acá: una
    // lista a mano confirmaría mi suposición en vez de lo que el bot manda.
    assert.deepEqual(
      conOpciones.opciones.map((o) => o.id),
      OPCIONES_MENU.map((o) => o.id),
    );
  });

  it("contestar «1» arranca el flujo de retiro", async () => {
    const { ultimo, puertos } = await conversar([{ texto: "1" }], sinForzar);
    assert.equal(
      ultimo.flujoActivo,
      "retiro_no_habitual",
      `el «1» no arrancó nada. Dicho: ${dicho(puertos)}`,
    );
  });

  it("contestar «2» arranca el flujo de reclamo", async () => {
    const { ultimo } = await conversar([{ texto: "2" }], sinForzar);
    assert.equal(ultimo.flujoActivo, "reclamo_recoleccion");
  });

  it("elegir del menú NO llama al clasificador", async () => {
    // El vecino ya dijo qué quiere: adivinarlo con el modelo es gastar plata en
    // algo que está dicho.
    let llamadas = 0;
    const base = puertosPrueba(sinForzar);
    const espiado = {
      ...base,
      clasificar: async (t: string, c: Parameters<typeof base.clasificar>[1]) => {
        llamadas++;
        return base.clasificar(t, c);
      },
    };

    await procesarMensaje(msg({ texto: "3" }), espiado);
    assert.equal(llamadas, 0, "se llamó al clasificador para un número del menú");
  });

  it("tocar el botón funciona igual que escribir el número", async () => {
    const { ultimo } = await conversar([{ seleccion: "reclamo_recoleccion" }], sinForzar);
    assert.equal(ultimo.flujoActivo, "reclamo_recoleccion");
  });

  it("una PREGUNTA sobre el camión no arranca el flujo de reclamo", async () => {
    // La contracara, y es lo que hay que no romper: «camión» aparece en la
    // etiqueta de la opción 2, pero quien pregunta cuándo pasa quiere una
    // respuesta, no abrir un reclamo. Eso lo decide el clasificador.
    let llamadas = 0;
    const base = puertosPrueba(sinForzar);
    const espiado = {
      ...base,
      clasificar: async (t: string, c: Parameters<typeof base.clasificar>[1]) => {
        llamadas++;
        return base.clasificar(t, c);
      },
    };

    await procesarMensaje(msg({ texto: "cuando pasa el camion por mi casa?" }), espiado);
    assert.equal(llamadas, 1, "una pregunta tiene que pasar por el clasificador");
  });

  it("dentro de un flujo, el número elige la opción de ESE paso", async () => {
    // El menú ya no está: las opciones vigentes son las del paso. Un «2» acá es
    // «Restos de poda / ramas», no la opción 2 del menú.
    const { puertos } = await conversar(
      [
        { texto: "necesito un retiro" },
        { media: { tipo: "imagen", referencia: "foto-1" } },
        { texto: "2" },
        { texto: "3 bolsas" },
        { texto: "Lamadrid 50" },
      ],
      { intencion: "retiro_no_habitual", confianza: 0.95 },
    );

    const ticket = puertos.registro.efectos.find((e) => e.tipo === "crear_ticket");
    assert.ok(ticket, `no se creó el ticket. Dicho: ${dicho(puertos)}`);
    if (ticket?.tipo !== "crear_ticket") return;
    assert.equal(ticket.datos.tipoResiduo, "poda", "el «2» no eligió la segunda categoría");
  });
});
