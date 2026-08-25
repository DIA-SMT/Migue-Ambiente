/**
 * Derivar a Migue lo que no es de la Secretaría de Ambiente.
 *
 * LA REGLA, definida con el área: el menú UNA vez, y si el vecino insiste con
 * algo que sigue sin encajar, se deriva al asistente general del municipio.
 *
 * Por qué no se deriva al primer fallo, que era la alternativa: de los tres
 * mensajes reales que cayeron en el menú en producción, uno era `/start`, otro un
 * número de menú y el tercero un reclamo que el clasificador leyó mal. Derivando
 * de una, ese tercer vecino habría sido mandado a otro número por un error
 * NUESTRO. El menú es la red.
 *
 * Lo que estas pruebas defienden, en orden de qué tan caro es equivocarse:
 *
 *   1. Que NO se derive a la primera. Un vecino echado de más es peor que uno
 *      que ve el menú dos veces.
 *   2. Que sin enlace cargado NO se derive. Decirle «escribile a Migue» sin
 *      decirle a dónde es dejarlo peor que antes.
 *   3. Que la derivación quede registrada, porque la pregunta que le importa al
 *      área no es cuántas derivamos: es cuántas eran nuestras.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { procesarMensaje } from "./orquestador.ts";
import { puertosPrueba, type OpcionesPuertos } from "./_puertos.ts";
import { AHORA, catalogoPrueba } from "../flujos/_fixtures.ts";
import type { MensajeEntrante } from "../mensajeria.ts";

const ENLACE = "https://wa.me/5493815550000";

function msg(parcial: Partial<MensajeEntrante> = {}): MensajeEntrante {
  return {
    canal: "telegram",
    canalUsuarioId: "555",
    nombreUsuario: "Vecino",
    texto: null,
    media: null,
    seleccion: null,
    recibidoEn: AHORA,
    ...parcial,
  };
}

/** Un catálogo con el enlace cargado, que es el estado con la derivación activa. */
function conEnlace(extra: Partial<OpcionesPuertos> = {}): OpcionesPuertos {
  const base = catalogoPrueba();
  const configuracion = new Map(base.configuracion);
  configuracion.set("enlace_migue", ENLACE);
  return { ...extra, catalogo: catalogoPrueba({ configuracion }) };
}

/** El clasificador no entiende nada: todo cae en el menú. */
const NO_ENTIENDE: Partial<OpcionesPuertos> = { intencion: "no_entendido" };

async function conversar(turnos: readonly Partial<MensajeEntrante>[], opciones: OpcionesPuertos) {
  const puertos = puertosPrueba(opciones);
  for (const t of turnos) await procesarMensaje(msg(t), puertos);
  return puertos;
}

describe("el menú primero, la derivación después", () => {
  it("al primer mensaje que no entiende, muestra el menú y NO deriva", async () => {
    const puertos = await conversar(
      [{ texto: "necesito una habilitacion comercial" }],
      conEnlace(NO_ENTIENDE),
    );

    assert.equal(puertos.registro.salientes.length, 1);
    const unico = puertos.registro.salientes[0]!;
    assert.equal(unico.traza.origenRespuesta, "fallback", "tendría que ser el menú");
    assert.ok(unico.opciones.length > 0, "el menú tiene que ofrecer opciones");
    assert.ok(
      !unico.texto.includes(ENLACE),
      "no puede derivar sin darle antes la chance de elegir una opción",
    );
    assert.equal(puertos.registro.sinRespuesta.length, 0, "todavía no hay nada que registrar");
  });

  it("si insiste, deriva", async () => {
    const puertos = await conversar(
      [
        { texto: "necesito una habilitacion comercial" },
        { texto: "no, habilitacion comercial" },
      ],
      conEnlace(NO_ENTIENDE),
    );

    assert.equal(puertos.registro.salientes.length, 2);
    const segundo = puertos.registro.salientes[1]!;
    assert.ok(segundo.texto.includes(ENLACE), `no derivó: «${segundo.texto}»`);
    assert.equal(segundo.traza.origenRespuesta, "exclusion");
    assert.equal(segundo.opciones.length, 0, "una derivación no ofrece opciones del menú");
  });

  // El caso que justifica que el menú vaya primero: el vecino elige una opción y
  // era nuestro. Si se derivara de una, este vecino se iba a otro número.
  it("si elige una opción del menú, NO se deriva: era nuestro", async () => {
    const puertos = await conversar(
      [{ texto: "algo que no se entiende" }, { seleccion: "reclamo_recoleccion" }],
      conEnlace(NO_ENTIENDE),
    );

    for (const s of puertos.registro.salientes) {
      assert.ok(!s.texto.includes(ENLACE), "eligió una opción de Ambiente: no hay que derivarlo");
    }
    assert.equal(puertos.registro.sinRespuesta.length, 0);
  });
});

describe("cuándo NO se puede derivar", () => {
  // Arranca vacío en producción a propósito. Hasta que el área cargue el enlace
  // en Reglas, mandarle «escribile a Migue» sin decirle a dónde lo deja peor que
  // repitiendo el menú.
  it("sin enlace cargado, vuelve al menú en vez de derivar", async () => {
    const puertos = await conversar(
      [{ texto: "una cosa raRa" }, { texto: "otra cosa rara" }],
      { ...NO_ENTIENDE, catalogo: catalogoPrueba() },  // el fixture lo tiene vacío
    );

    assert.equal(puertos.registro.salientes.length, 2);
    for (const s of puertos.registro.salientes) {
      assert.equal(s.traza.origenRespuesta, "fallback", "sin enlace, siempre el menú");
      assert.ok(s.opciones.length > 0);
    }
  });

  // Vaciar el texto desde el panel es la forma de apagar la derivación sin un
  // deploy, igual que con el voto.
  it("vaciar el texto desde el panel apaga la derivación", async () => {
    const base = catalogoPrueba();
    const configuracion = new Map(base.configuracion);
    configuracion.set("enlace_migue", ENLACE);
    const textos = new Map(base.textos);
    textos.set("derivar_a_migue", "   ");

    const puertos = await conversar([{ texto: "una cosa" }, { texto: "otra cosa" }], {
      ...NO_ENTIENDE,
      catalogo: catalogoPrueba({ configuracion, textos }),
    });

    for (const s of puertos.registro.salientes) {
      assert.equal(s.traza.origenRespuesta, "fallback");
    }
  });
});

describe("qué queda registrado al derivar", () => {
  // La pregunta que le importa al área no es cuántas derivamos: es cuántas eran
  // NUESTRAS. Sin registrar la pregunta no hay forma de contestarla.
  it("la pregunta queda con motivo fuera_de_alcance", async () => {
    const puertos = await conversar(
      [{ texto: "primera" }, { texto: "donde saco la licencia de conducir" }],
      conEnlace(NO_ENTIENDE),
    );

    assert.equal(puertos.registro.sinRespuesta.length, 1);
    const fila = puertos.registro.sinRespuesta[0]!;
    assert.equal(fila.pregunta, "donde saco la licencia de conducir");
    assert.equal(
      fila.motivo,
      "fuera_de_alcance",
      "no es «no encontré nada»: es «esto no es de Ambiente», y el arreglo es otro",
    );
  });

  // Un toque de botón no es una pregunta. Registrarlo llenaría la lista de ids
  // internos, que es el mismo error que ya se cometió con el comentario del voto.
  it("una selección sin texto no se registra como pregunta", async () => {
    const puertos = await conversar(
      [{ texto: "primera" }, { seleccion: "algo_que_no_existe" }],
      conEnlace(NO_ENTIENDE),
    );

    for (const s of puertos.registro.sinRespuesta) {
      assert.notEqual(s.pregunta, "algo_que_no_existe");
    }
  });
});

describe("lo que la derivación NO toca", () => {
  // Las 7 reglas de exclusión siguen derivando al organismo que corresponde. Una
  // fuga de gas tiene que ir a Gasnor YA, no a otro bot que va a volver a
  // preguntar: el salto de más cuesta tiempo justo donde el tiempo importa.
  it("una urgencia sigue yendo directo al organismo, sin pasar por Migue", async () => {
    const puertos = await conversar(
      [{ texto: "hay olor a gas en la esquina" }],
      conEnlace(NO_ENTIENDE),
    );

    const primero = puertos.registro.salientes[0]!;
    assert.equal(primero.traza.origenRespuesta, "exclusion");
    assert.ok(
      !primero.texto.includes(ENLACE),
      "una urgencia de gas no se manda a otro bot: va al organismo",
    );
  });

  it("un trámite de Ambiente no se deriva nunca", async () => {
    const puertos = await conversar(
      [{ texto: "necesito que retiren escombros" }],
      conEnlace({ intencion: "retiro_no_habitual" }),
    );

    for (const s of puertos.registro.salientes) {
      assert.ok(!s.texto.includes(ENLACE), "es un trámite nuestro");
    }
  });
});
