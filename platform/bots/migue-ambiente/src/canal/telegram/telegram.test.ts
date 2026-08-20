import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizarMensaje, normalizarSeleccion } from "./normalizar.ts";
import { armarTeclado, partirTexto, renderizar } from "./renderizar.ts";
import type { CallbackQuery, Message } from "grammy/types";

/** Mensaje de Telegram mínimo, con lo que se le agregue encima. */
function msg(parcial: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 1_787_000_000,
    chat: { id: 987654, type: "private", first_name: "Vecino" },
    from: { id: 987654, is_bot: false, first_name: "Ana", last_name: "Gómez" },
    ...parcial,
  } as Message;
}

describe("normalizarMensaje", () => {
  it("traduce un mensaje de texto", () => {
    const e = normalizarMensaje(msg({ text: "necesito un retiro" }));
    assert.equal(e.canal, "telegram");
    assert.equal(e.canalUsuarioId, "987654");
    assert.equal(e.texto, "necesito un retiro");
    assert.equal(e.nombreUsuario, "Ana Gómez");
    assert.equal(e.media, null);
  });

  it("usa el @usuario si no hay nombre", () => {
    const e = normalizarMensaje(
      msg({ text: "hola", from: { id: 1, is_bot: false, first_name: "", username: "anag" } }),
    );
    assert.equal(e.nombreUsuario, "@anag");
  });

  it("toma la foto de MAYOR resolución", () => {
    // Telegram manda varias resoluciones. Las chicas están comprimidas al punto
    // de que no se distingue si son cinco bolsas o quince, y la foto es
    // justamente lo que se usa para decidir qué camión enviar.
    const e = normalizarMensaje(
      msg({
        photo: [
          { file_id: "chica", file_unique_id: "a", width: 90, height: 90, file_size: 1000 },
          { file_id: "mediana", file_unique_id: "b", width: 320, height: 320, file_size: 20000 },
          { file_id: "grande", file_unique_id: "c", width: 1280, height: 1280, file_size: 200000 },
        ],
      }),
    );
    assert.equal(e.media?.tipo, "imagen");
    assert.equal(e.media?.referencia, "grande");
    assert.equal(e.media?.bytes, 200000);
  });

  it("el pie de la foto cuenta como texto", () => {
    // Mucha gente manda la foto con la dirección escrita en el pie. Ignorarlo
    // obligaría a repreguntar un dato que ya dieron.
    const e = normalizarMensaje(
      msg({
        photo: [{ file_id: "f", file_unique_id: "a", width: 100, height: 100 }],
        caption: "Lamadrid 50, son 4 bolsas",
      }),
    );
    assert.equal(e.texto, "Lamadrid 50, son 4 bolsas");
    assert.equal(e.media?.tipo, "imagen");
  });

  it("una foto enviada COMO ARCHIVO también es una imagen", () => {
    // Mucha gente manda las fotos como archivo para que no se compriman.
    // Rechazarlas por venir en otro campo sería absurdo cuando la foto es lo
    // que estamos pidiendo.
    const e = normalizarMensaje(
      msg({
        document: {
          file_id: "doc-imagen",
          file_unique_id: "x",
          mime_type: "image/jpeg",
          file_size: 500000,
        },
      }),
    );
    assert.equal(e.media?.tipo, "imagen");
    assert.equal(e.media?.referencia, "doc-imagen");
  });

  it("un PDF no es una imagen", () => {
    const e = normalizarMensaje(
      msg({
        document: { file_id: "pdf", file_unique_id: "y", mime_type: "application/pdf" },
      }),
    );
    assert.equal(e.media?.tipo, "documento");
  });

  it("reconoce audio, video y ubicación", () => {
    assert.equal(
      normalizarMensaje(msg({ voice: { file_id: "v", file_unique_id: "a", duration: 5 } })).media?.tipo,
      "audio",
    );
    assert.equal(
      normalizarMensaje(
        msg({ video: { file_id: "vd", file_unique_id: "b", width: 1, height: 1, duration: 1 } }),
      ).media?.tipo,
      "video",
    );
    const ubi = normalizarMensaje(msg({ location: { latitude: -26.82, longitude: -65.2 } }));
    assert.equal(ubi.media?.tipo, "ubicacion");
    assert.equal(ubi.media?.referencia, "-26.82,-65.2");
  });

  it("no pide ni inventa el teléfono", () => {
    // Telegram no lo da salvo que el usuario lo comparta, y la spec no lo
    // necesita para este canal.
    assert.equal(normalizarMensaje(msg({ text: "hola" })).telefono, null);
  });

  it("convierte la fecha de Telegram, que viene en segundos", () => {
    const e = normalizarMensaje(msg({ text: "hola", date: 1_787_000_000 }));
    assert.equal(e.recibidoEn.getTime(), 1_787_000_000_000);
  });
});

describe("normalizarSeleccion", () => {
  it("la elección va en `seleccion`, no en `texto`", () => {
    // Es un dato estructurado: volver a interpretarlo con lenguaje natural
    // sería tirar información que ya tenemos exacta.
    const consulta = {
      id: "1",
      from: { id: 987654, is_bot: false, first_name: "Ana" },
      chat_instance: "x",
      data: "escombros",
      message: msg(),
    } as CallbackQuery;

    const e = normalizarSeleccion(consulta)!;
    assert.equal(e.seleccion, "escombros");
    assert.equal(e.texto, null);
    assert.equal(e.canalUsuarioId, "987654");
  });

  it("sin mensaje asociado devuelve null en vez de romper", () => {
    const consulta = {
      id: "1",
      from: { id: 1, is_bot: false, first_name: "A" },
      chat_instance: "x",
      data: "algo",
    } as CallbackQuery;
    assert.equal(normalizarSeleccion(consulta), null);
  });
});

describe("partirTexto", () => {
  it("un texto corto no se parte", () => {
    assert.deepEqual(partirTexto("corto"), ["corto"]);
  });

  it("parte por párrafos y ninguna parte excede el límite", () => {
    const parrafo = "a".repeat(100);
    const largo = Array.from({ length: 60 }, () => parrafo).join("\n\n");
    const partes = partirTexto(largo, 500);
    assert.ok(partes.length > 1);
    for (const p of partes) assert.ok(p.length <= 500, `una parte mide ${p.length}`);
  });

  it("parte por líneas cuando un párrafo solo ya excede", () => {
    const lineas = Array.from({ length: 50 }, (_, i) => `linea ${i} ${"x".repeat(20)}`).join("\n");
    const partes = partirTexto(lineas, 200);
    for (const p of partes) assert.ok(p.length <= 200);
  });

  it("no pierde contenido al partir", () => {
    const original = Array.from({ length: 30 }, (_, i) => `parrafo ${i}`).join("\n\n");
    const unido = partirTexto(original, 60).join("\n\n");
    assert.equal(unido.replace(/\s+/g, " "), original.replace(/\s+/g, " "));
  });
});

describe("armarTeclado", () => {
  it("sin opciones no hay teclado", () => {
    assert.equal(armarTeclado({ texto: "hola" }), undefined);
    assert.equal(armarTeclado({ texto: "hola", opciones: [] }), undefined);
  });

  it("un botón por fila", () => {
    // Las etiquetas de este bot son largas («Escombros / material de
    // construcción») y dos por fila quedan cortadas en un teléfono.
    const teclado = armarTeclado({
      texto: "¿qué tipo?",
      opciones: [
        { id: "escombros", etiqueta: "Escombros / material de construcción" },
        { id: "poda", etiqueta: "Restos de poda / ramas" },
      ],
    })!;
    assert.equal(teclado.inline_keyboard.length, 2, "dos filas");
    assert.equal(teclado.inline_keyboard[0]?.length, 1, "un botón por fila");
  });

  it("descarta una opción cuyo id no entra en callback_data", () => {
    // El límite de Telegram son 64 bytes. Que una opción demasiado larga haga
    // fallar el envío completo sería peor que perder ese botón.
    const teclado = armarTeclado({
      texto: "elegí",
      opciones: [
        { id: "x".repeat(100), etiqueta: "Demasiado larga" },
        { id: "ok", etiqueta: "Válida" },
      ],
    })!;
    assert.equal(teclado.inline_keyboard.length, 1);
  });

  it("si TODAS las opciones son inválidas no manda teclado vacío", () => {
    assert.equal(
      armarTeclado({ texto: "elegí", opciones: [{ id: "x".repeat(100), etiqueta: "Mala" }] }),
      undefined,
    );
  });
});

describe("renderizar", () => {
  it("un saliente simple es un envío", () => {
    const envios = renderizar({ texto: "Listo." });
    assert.equal(envios.length, 1);
    assert.equal(envios[0]?.texto, "Listo.");
    assert.equal(envios[0]?.teclado, undefined);
  });

  it("el teclado va SÓLO en el último envío", () => {
    // Si el texto se partió, los botones tienen que quedar junto a la pregunta
    // y no perdidos en el medio de la conversación.
    // Tiene que pasar de 4096 caracteres de verdad: con 200 párrafos cortos
    // apenas llegaba a 3888 y el texto no se partía, así que el test no
    // probaba nada.
    const largo = Array.from({ length: 400 }, (_, i) => `parrafo numero ${i}`).join("\n\n");
    assert.ok(largo.length > 4096, `el texto de prueba mide ${largo.length}, debe pasar 4096`);

    const envios = renderizar({
      texto: largo,
      opciones: [{ id: "si", etiqueta: "Sí" }],
    });
    assert.ok(envios.length > 1, "el texto tenía que partirse");
    for (const envio of envios.slice(0, -1)) assert.equal(envio.teclado, undefined);
    assert.ok(envios.at(-1)?.teclado, "el último lleva el teclado");
  });
});
