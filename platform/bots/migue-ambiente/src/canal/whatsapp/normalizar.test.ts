import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizarMensaje } from "./normalizar.ts";
import type { MensajeCrudo } from "./webhook.ts";

/** Un MensajeCrudo como los que arma abrirEntrega. */
function crudo(tipo: string, cuerpo: Record<string, unknown> = {}): MensajeCrudo {
  return {
    id: "wamid.PRUEBA",
    de: "5493810000001",
    tipo,
    nombre: "Ana",
    timestamp: "1787000000",
    crudo: { from: "5493810000001", id: "wamid.PRUEBA", type: tipo, ...cuerpo },
  };
}

describe("los campos comunes", () => {
  it("canal, teléfono, wamid y fecha vienen del sobre", () => {
    const e = normalizarMensaje(crudo("text", { text: { body: "hola" } }))!;
    assert.equal(e.canal, "whatsapp");
    assert.equal(e.canalUsuarioId, "5493810000001");
    // En WhatsApp el identificador ES el teléfono — a diferencia de Telegram,
    // donde telefono va null a propósito.
    assert.equal(e.telefono, "5493810000001");
    assert.equal(e.nombreUsuario, "Ana");
    assert.equal(e.canalMensajeId, "wamid.PRUEBA");
    assert.equal(e.recibidoEn.getTime(), 1787000000 * 1000);
  });

  it("un timestamp inválido no rompe: usa ahora", () => {
    const antes = Date.now();
    const e = normalizarMensaje({ ...crudo("text", { text: { body: "x" } }), timestamp: "" })!;
    assert.ok(e.recibidoEn.getTime() >= antes);
  });
});

describe("traducción por tipo", () => {
  it("text: el body es el texto", () => {
    const e = normalizarMensaje(crudo("text", { text: { body: "necesito un retiro" } }))!;
    assert.equal(e.texto, "necesito un retiro");
    assert.equal(e.media, null);
    assert.equal(e.seleccion, null);
  });

  it("image: el media id es la referencia y el pie cuenta como texto", () => {
    const e = normalizarMensaje(
      crudo("image", { image: { id: "MEDIA123", mime_type: "image/jpeg", caption: "Lamadrid 50" } }),
    )!;
    assert.deepEqual(e.media, { tipo: "imagen", referencia: "MEDIA123", mime: "image/jpeg", bytes: null });
    assert.equal(e.texto, "Lamadrid 50");
  });

  it("document con mime de imagen cuenta como imagen (foto mandada como archivo)", () => {
    const e = normalizarMensaje(
      crudo("document", { document: { id: "DOC1", mime_type: "image/png" } }),
    )!;
    assert.equal(e.media?.tipo, "imagen");
  });

  it("document pdf es documento", () => {
    const e = normalizarMensaje(
      crudo("document", { document: { id: "DOC2", mime_type: "application/pdf", caption: "informe" } }),
    )!;
    assert.equal(e.media?.tipo, "documento");
    assert.equal(e.texto, "informe");
  });

  it("audio y video llevan su media", () => {
    assert.equal(
      normalizarMensaje(crudo("audio", { audio: { id: "A1", mime_type: "audio/ogg" } }))!.media?.tipo,
      "audio",
    );
    assert.equal(
      normalizarMensaje(crudo("video", { video: { id: "V1", mime_type: "video/mp4" } }))!.media?.tipo,
      "video",
    );
  });

  it("location: el GPS se registra pero la dirección se sigue pidiendo escrita", () => {
    const e = normalizarMensaje(
      crudo("location", { location: { latitude: -26.83, longitude: -65.2 } }),
    )!;
    assert.deepEqual(e.media, { tipo: "ubicacion", referencia: "-26.83,-65.2", mime: null, bytes: null });
    assert.equal(e.texto, null);
  });

  it("button_reply: el id del botón es la selección, tal cual", () => {
    const e = normalizarMensaje(
      crudo("interactive", {
        interactive: {
          type: "button_reply",
          button_reply: { id: "voto_util:123e4567-e89b-12d3-a456-426614174000", title: "👍 Sí, me sirvió" },
        },
      }),
    )!;
    assert.equal(e.seleccion, "voto_util:123e4567-e89b-12d3-a456-426614174000");
    assert.equal(e.texto, null);
  });

  it("list_reply: el id de la fila es la selección", () => {
    const e = normalizarMensaje(
      crudo("interactive", {
        interactive: { type: "list_reply", list_reply: { id: "retiro_no_habitual", title: "Retirar…" } },
      }),
    )!;
    assert.equal(e.seleccion, "retiro_no_habitual");
  });

  it("button de plantilla: el payload cuenta como selección", () => {
    const e = normalizarMensaje(crudo("button", { button: { payload: "opcion_x", text: "Opción X" } }))!;
    assert.equal(e.seleccion, "opcion_x");
  });

  it("un «1» ESCRITO queda como texto: los números los resuelve el dominio", () => {
    const e = normalizarMensaje(crudo("text", { text: { body: "1" } }))!;
    assert.equal(e.texto, "1");
    assert.equal(e.seleccion, null);
  });
});

describe("lo que no merece turno", () => {
  it("sticker, reaction y system se descartan", () => {
    for (const tipo of ["sticker", "reaction", "system"]) {
      assert.equal(normalizarMensaje(crudo(tipo)), null, tipo);
    }
  });

  it("sin remitente no hay a quién contestarle", () => {
    assert.equal(normalizarMensaje({ ...crudo("text", { text: { body: "x" } }), de: "" }), null);
  });

  it("un tipo desconocido normaliza vacío: el menú es mejor que el silencio", () => {
    const e = normalizarMensaje(crudo("order", { order: {} }));
    assert.notEqual(e, null);
    assert.equal(e!.texto, null);
    assert.equal(e!.media, null);
  });
});
