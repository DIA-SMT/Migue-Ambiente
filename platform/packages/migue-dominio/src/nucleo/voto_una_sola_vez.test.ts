/**
 * El voto se cierra con el primer toque.
 *
 * ESTAS PRUEBAS EXISTEN PORQUE EL BUG LLEGÓ A PRODUCCIÓN SIN QUE NADA LO VIERA.
 * Probando el bot se pudo votar 👍 👎 👍 👎 sobre la misma respuesta, y Migue
 * agradeció cada vez, como si cada toque contara.
 *
 * Y la razón de que nadie lo viera es la que importa: el doble toque SÍ estaba
 * cubierto, pero sólo en SQL —el bloque N del arnés afirmaba que dos toques no
 * crean dos filas— y esa era la pregunta equivocada. Nunca hubo filas
 * duplicadas. Lo que había era un `on conflict do update` que CAMBIABA el voto,
 * y un bot que volvía a contestar. La prueba miraba la tabla; el vecino veía la
 * conversación.
 *
 * Así que estas pruebas afirman sobre lo que el vecino ve: cuántos mensajes
 * recibe y si le quedan botones para seguir tocando.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { procesarMensaje } from "./orquestador.ts";
import { puertosPrueba, type OpcionesPuertos } from "./_puertos.ts";
import { AHORA } from "../flujos/_fixtures.ts";
import type { MensajeEntrante } from "../mensajeria.ts";

const USUARIO = "606";

function msg(parcial: Partial<MensajeEntrante> = {}): MensajeEntrante {
  return {
    canal: "telegram",
    canalUsuarioId: USUARIO,
    nombreUsuario: "Vecina Prueba",
    texto: null,
    media: null,
    seleccion: null,
    recibidoEn: AHORA,
    ...parcial,
  };
}

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

/**
 * Deja una respuesta votable y devuelve el id del botón de voto que el bot
 * realmente ofreció.
 *
 * Se LEE del registro en vez de construirlo a mano. Un id inventado acá probaría
 * que el orquestador maneja el id que yo elegí, no el que él emite — y el bug
 * original vivía justamente en la diferencia entre esas dos cosas.
 */
async function prepararVotable() {
  const puertos = puertosPrueba(RESPONDIO);
  await procesarMensaje(msg({ texto: "cuando pasa el camión de poda" }), puertos);

  const conBotones = puertos.registro.salientes.find((s) =>
    s.opciones.some((o) => o.id.startsWith("voto_")),
  );
  assert.ok(conBotones, "el bot no ofreció botones de voto: la prueba no puede seguir");

  const utiles = conBotones.opciones.filter((o) => o.id.startsWith("voto_util"));
  const noUtiles = conBotones.opciones.filter((o) => o.id.startsWith("voto_no_util"));
  assert.equal(utiles.length, 1, "esperaba un solo botón de pulgar arriba");
  assert.equal(noUtiles.length, 1, "esperaba un solo botón de pulgar abajo");

  return {
    puertos,
    arriba: utiles[0]!.id,
    abajo: noUtiles[0]!.id,
    salientesAntes: puertos.registro.salientes.length,
  };
}

describe("el voto se cierra con el primer toque", () => {
  it("el primer toque agradece y le saca los botones", async () => {
    const { puertos, arriba } = await prepararVotable();

    const r = await procesarMensaje(msg({ seleccion: arriba }), puertos);

    assert.equal(r.salientes.length, 1, "el primer voto tiene que recibir acuse");
    assert.equal(
      r.quitarBotones,
      true,
      "hay que quitarle el teclado: si queda, el vecino sigue tocando",
    );
  });

  it("EL BUG: el segundo toque no contesta nada", async () => {
    const { puertos, arriba } = await prepararVotable();

    const primero = await procesarMensaje(msg({ seleccion: arriba }), puertos);
    const segundo = await procesarMensaje(msg({ seleccion: arriba }), puertos);

    assert.equal(primero.salientes.length, 1);
    assert.equal(
      segundo.salientes.length,
      0,
      "volvió a agradecer un voto que ya estaba: es el bug que se vio probando",
    );
  });

  it("y cambiar de opinión tampoco contesta: el primer toque manda", async () => {
    const { puertos, arriba, abajo } = await prepararVotable();

    const pulgarAbajo = await procesarMensaje(msg({ seleccion: abajo }), puertos);
    const arrepentido = await procesarMensaje(msg({ seleccion: arriba }), puertos);

    assert.equal(pulgarAbajo.salientes.length, 1, "el 👎 tiene que pedir el detalle");
    assert.equal(
      arrepentido.salientes.length,
      0,
      "el 👍 posterior no tiene que generar un «¡Buenísimo!»",
    );

    // Los dos intentos quedan registrados —el bot intentó— y es la BASE la que
    // decide que el segundo no cambia nada. Afirmar acá que el voto guardado es
    // el primero sería afirmar sobre el doble, no sobre Postgres; eso lo prueba
    // el bloque N del arnés, que corre SQL de verdad.
    assert.equal(puertos.registro.votos.length, 2, "los dos toques se intentaron");
    assert.equal(puertos.registro.votos[0]!.voto, "no_util");
  });

  it("pero el teclado se quita en los dos casos", async () => {
    const { puertos, arriba } = await prepararVotable();

    await procesarMensaje(msg({ seleccion: arriba }), puertos);
    const segundo = await procesarMensaje(msg({ seleccion: arriba }), puertos);

    // Un segundo toque sólo puede venir de un teclado viejo del historial. Que
    // ese teclado también desaparezca es lo que corta la serie: si sólo se
    // quitara el primero, el vecino podría subir en el chat y seguir tocando.
    assert.equal(segundo.quitarBotones, true);
  });
});

describe("lo que el bloqueo NO tiene que romper", () => {
  it("votar la respuesta y votar el trámite son DOS votos, no uno", async () => {
    // El arreglo fácil y equivocado es «un voto por conversación». Rompería la
    // encuesta del trámite: el vecino que pregunta algo, vota, y después hace un
    // pedido, tiene dos cosas distintas para calificar.
    const puertos = puertosPrueba(RESPONDIO);
    await procesarMensaje(msg({ texto: "cuando pasa el camión de poda" }), puertos);

    const primerTeclado = puertos.registro.salientes.find((s) =>
      s.opciones.some((o) => o.id.startsWith("voto_util")),
    );
    const votoRespuesta = primerTeclado!.opciones.find((o) => o.id.startsWith("voto_util"))!.id;

    const r1 = await procesarMensaje(msg({ seleccion: votoRespuesta }), puertos);
    assert.equal(r1.salientes.length, 1, "el voto de la respuesta tiene que acusar");

    // Ahora una segunda respuesta, con su propio teclado y su propio mensaje.
    await procesarMensaje(msg({ texto: "y los escombros?" }), puertos);
    const tecladosDeVoto = puertos.registro.salientes.filter((s) =>
      s.opciones.some((o) => o.id.startsWith("voto_util")),
    );
    assert.equal(tecladosDeVoto.length, 2, "la segunda respuesta también se ofrece a votación");

    const otroVoto = tecladosDeVoto[1]!.opciones.find((o) => o.id.startsWith("voto_util"))!.id;
    assert.notEqual(otroVoto, votoRespuesta, "los dos botones tienen que apuntar a mensajes distintos");

    const r2 = await procesarMensaje(msg({ seleccion: otroVoto }), puertos);
    assert.equal(
      r2.salientes.length,
      1,
      "votar OTRA respuesta es un voto nuevo, no un segundo toque",
    );
  });

  it("un mensaje normal no le quita los botones a nada", async () => {
    // `quitarBotones` sale de un solo camino. Si saliera true en cualquier turno,
    // el adaptador borraría el teclado del menú y el vecino se quedaría sin
    // opciones para elegir.
    const puertos = puertosPrueba(RESPONDIO);
    const r = await procesarMensaje(msg({ texto: "cuando pasa el camión de poda" }), puertos);
    assert.equal(r.quitarBotones, false);
  });

  it("y el emoji suelto también se bloquea en el segundo", async () => {
    // Sin botón, la base infiere el mensaje por conversación y siempre resuelve
    // al mismo. Dos 👍 escritos a mano son dos toques sobre el mismo voto.
    const puertos = puertosPrueba(RESPONDIO);
    await procesarMensaje(msg({ texto: "cuando pasa el camión de poda" }), puertos);

    const primero = await procesarMensaje(msg({ texto: "👍" }), puertos);
    const segundo = await procesarMensaje(msg({ texto: "👍" }), puertos);

    assert.equal(primero.salientes.length, 1, "el primer 👍 escrito tiene que acusar");
    assert.equal(segundo.salientes.length, 0, "el segundo 👍 no tiene que volver a acusar");
  });
});
