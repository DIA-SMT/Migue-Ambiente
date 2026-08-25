/**
 * La encuesta al terminar un trámite.
 *
 * Salió de probar el bot: se completó un pedido de retiro entero —cinco pasos,
 * una foto, la dirección, «✅ Solicitud registrada»— y no preguntó nada. El voto
 * sólo aparecía después de una RESPUESTA, y un trámite no es una respuesta.
 *
 * Lo que estas pruebas defienden, en orden de qué tan caro es equivocarse:
 *
 *   1. Que NO aparezca si el vecino canceló o abandonó. Preguntarle «¿te resultó
 *      fácil?» a alguien que se fue a la mitad es peor que no preguntar.
 *   2. Que el voto quede registrado como `tramite` y no como `respuesta`: los
 *      arreglos son opuestos —cambiar los pasos vs. escribir mejor— y mezclarlos
 *      deja al área con un número que no dice qué hacer.
 *   3. Que tras el pulgar abajo se pregunte por el PROCESO. «¿Qué te falta
 *      saber?» no aplica cuando lo difícil fue el trámite.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { procesarMensaje } from "./orquestador.ts";
import { puertosPrueba, type OpcionesPuertos } from "./_puertos.ts";
import { AHORA, catalogoPrueba } from "../flujos/_fixtures.ts";
import type { MensajeEntrante } from "../mensajeria.ts";

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

/**
 * Un retiro completo, en el orden REAL del flujo: la foto primero, después el
 * tipo y la cantidad en un mismo mensaje, y al final la dirección.
 *
 * Mi primera versión ponía el tipo antes de la foto y separaba la cantidad, y el
 * trámite no llegaba a crear el ticket. Lo detectó la propia aserción de la
 * prueba —«el trámite no llegó a crear el ticket: la prueba no está midiendo lo
 * que dice»— que está ahí justamente para eso: sin ella, la encuesta no habría
 * aparecido y yo habría concluido que el código estaba mal.
 */
const RETIRO_COMPLETO: readonly Partial<MensajeEntrante>[] = [
  { texto: "necesito que retiren escombros" },
  { media: { tipo: "imagen", referencia: "foto-1" } },
  { texto: "3 bolsas de escombros" },
  { texto: "Av. Sarmiento 1200 entre Muñecas y Laprida" },
];

async function conversar(
  turnos: readonly Partial<MensajeEntrante>[],
  opciones: OpcionesPuertos = {},
) {
  const puertos = puertosPrueba({ intencion: "retiro_no_habitual", ...opciones });
  for (const t of turnos) await procesarMensaje(msg(t), puertos);
  return puertos;
}

const esEncuesta = (s: { opciones: { id: string }[] }) =>
  s.opciones.some((o) => o.id.startsWith("voto_tramite_"));

describe("al completar un trámite", () => {
  it("pregunta cómo le resultó, como mensaje aparte", async () => {
    const puertos = await conversar(RETIRO_COMPLETO);

    // El ticket se creó: el trámite salió.
    assert.ok(
      puertos.registro.efectos.some((e) => e.tipo === "crear_ticket"),
      "el trámite no llegó a crear el ticket: la prueba no está midiendo lo que dice",
    );

    const encuesta = puertos.registro.salientes.filter(esEncuesta);
    assert.equal(encuesta.length, 1, "tendría que preguntar una sola vez");
    assert.match(encuesta[0]!.texto, /fácil/i);

    // Aparte de la confirmación, no pegada: el vecino tiene que poder reenviar
    // o guardar el comprobante sin arrastrar una pregunta de cortesía.
    const confirmacion = puertos.registro.salientes.find((s) => /Solicitud|registrad/i.test(s.texto));
    assert.ok(confirmacion, "no encontré la confirmación del pedido");
    assert.notEqual(confirmacion, encuesta[0], "la encuesta no puede ir dentro de la confirmación");
  });

  it("los botones dicen «fue fácil», no «me sirvió»", async () => {
    const puertos = await conversar(RETIRO_COMPLETO);
    const encuesta = puertos.registro.salientes.find(esEncuesta)!;
    const etiquetas = encuesta.opciones.map((o) => o.etiqueta).join(" ");
    assert.match(etiquetas, /fácil/i);
    assert.match(etiquetas, /complicad/i);
    assert.ok(
      !/sirvió/i.test(etiquetas),
      "«¿te sirvió?» no aplica a un pedido: lo que se pregunta es si el camino fue claro",
    );
  });

  // Vaciar el texto desde el panel apaga esta encuesta sin apagar la de las
  // respuestas. Es la misma puerta que tiene el otro voto.
  it("vaciar el texto desde el panel la apaga", async () => {
    const base = catalogoPrueba();
    const textos = new Map(base.textos);
    textos.set("seguimiento_tras_tramite", "   ");

    const puertos = await conversar(RETIRO_COMPLETO, { catalogo: catalogoPrueba({ textos }) });
    assert.equal(puertos.registro.salientes.filter(esEncuesta).length, 0);
  });
});

describe("cuándo NO se pregunta", () => {
  // EL CASO QUE MÁS IMPORTA. `avance.estado === null` también es null cuando el
  // vecino cancela, así que preguntar por el estado en vez de por los efectos
  // haría que el bot le pregunte «¿te resultó fácil?» a alguien que se fue.
  it("si el vecino cancela a mitad de camino, no se le pregunta nada", async () => {
    const puertos = await conversar([
      { texto: "necesito que retiren escombros" },
      { media: { tipo: "imagen", referencia: "foto-1" } },
      { texto: "cancelar" },
    ]);

    assert.equal(
      puertos.registro.salientes.filter(esEncuesta).length,
      0,
      "canceló: preguntarle si le resultó fácil es peor que no preguntar",
    );
    assert.ok(
      !puertos.registro.efectos.some((e) => e.tipo === "crear_ticket"),
      "no tenía que crear ningún ticket",
    );
  });

  it("a mitad de un trámite, con el flujo todavía abierto, tampoco", async () => {
    const puertos = await conversar([
      { texto: "necesito que retiren escombros" },
      { media: { tipo: "imagen", referencia: "foto-1" } },
    ]);
    assert.equal(puertos.registro.salientes.filter(esEncuesta).length, 0);
  });
});

describe("el voto del trámite se registra como tal", () => {
  it("queda como `tramite`, no como `respuesta`", async () => {
    const puertos = puertosPrueba();
    await procesarMensaje(msg({ seleccion: "voto_tramite_no_util:sal-9" }), puertos);

    assert.deepEqual(puertos.registro.votos, [
      { voto: "no_util", sobre: "tramite", mensajeId: "sal-9" },
    ]);
  });

  // Tras un pulgar abajo en un trámite, la pregunta es por el proceso. «¿Qué te
  // falta saber?» daría a entender que falta información, cuando lo que faltó
  // fue claridad en los pasos.
  it("pregunta qué fue complicado, no qué le falta saber", async () => {
    const puertos = puertosPrueba();
    await procesarMensaje(msg({ seleccion: "voto_tramite_no_util:sal-9" }), puertos);

    const ultimo = puertos.registro.salientes.at(-1)!;
    assert.match(ultimo.texto, /complicad/i);
    assert.ok(!/falta saber/i.test(ultimo.texto));
  });

  it("y el de una respuesta sigue preguntando qué le falta saber", async () => {
    const puertos = puertosPrueba();
    await procesarMensaje(msg({ seleccion: "voto_no_util:sal-3" }), puertos);

    const ultimo = puertos.registro.salientes.at(-1)!;
    assert.match(ultimo.texto, /falta saber/i);
    assert.deepEqual(puertos.registro.votos, [
      { voto: "no_util", sobre: "respuesta", mensajeId: "sal-3" },
    ]);
  });

  it("un pulgar arriba agradece igual en los dos casos", async () => {
    for (const sel of ["voto_util:sal-1", "voto_tramite_util:sal-1"]) {
      const puertos = puertosPrueba();
      await procesarMensaje(msg({ seleccion: sel }), puertos);
      assert.match(puertos.registro.salientes.at(-1)!.texto, /Buenísimo/i, sel);
    }
  });
});
