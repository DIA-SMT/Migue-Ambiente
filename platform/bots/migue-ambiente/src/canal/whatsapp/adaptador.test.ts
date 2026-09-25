import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crearAdaptadorWhatsApp } from "./adaptador.ts";
import type { Entrega, MensajeCrudo } from "./webhook.ts";
import type { enviarMensaje, marcarLeidoYEscribiendo } from "./cliente.ts";
import type { procesarMensaje } from "@migue/dominio";

const CONFIG = { token: "tok", numeroId: "123" };

function mensajeDeTexto(id: string, texto: string, de = "5493810000001"): MensajeCrudo {
  return {
    id,
    de,
    tipo: "text",
    nombre: "Ana",
    timestamp: "1787000000",
    crudo: { id, from: de, type: "text", text: { body: texto } },
  };
}

function entrega(...mensajes: MensajeCrudo[]): Entrega {
  return { mensajes, estados: 0 };
}

interface Espias {
  enviados: Array<{ a: string; tipo: string; texto?: string }>;
  leidos: string[];
  procesados: string[];
}

function armar(opciones?: {
  procesarImpl?: typeof procesarMensaje;
  enviarFalla?: (n: number) => boolean;
  marcarLeidoFalla?: boolean;
}) {
  const espias: Espias = { enviados: [], leidos: [], procesados: [] };
  let envios = 0;

  const enviar: typeof enviarMensaje = async (_c, a, envio) => {
    envios++;
    if (opciones?.enviarFalla?.(envios)) throw new Error("Meta caída");
    espias.enviados.push({ a, tipo: envio.tipo, ...(envio.tipo === "texto" ? { texto: envio.texto } : {}) });
    return `wamid.out.${envios}`;
  };

  const marcarLeido: typeof marcarLeidoYEscribiendo = async (_c, wamid) => {
    if (opciones?.marcarLeidoFalla) throw new Error("no se pudo");
    espias.leidos.push(wamid);
  };

  const procesar: typeof procesarMensaje =
    opciones?.procesarImpl ??
    (async (entrante) => {
      espias.procesados.push(entrante.texto ?? "");
      return {
        salientes: [
          { texto: "primera parte" },
          { texto: "¿te sirvió?", opciones: [{ id: "voto_util:1", etiqueta: "👍 Sí, me sirvió" }] },
        ],
        conversacionId: "conv-1",
        origenRespuesta: "flujo" as const,
        flujoActivo: null,
        efectos: [],
        quitarBotones: false,
      };
    });

  const adaptador = crearAdaptadorWhatsApp({
    config: CONFIG,
    puertos: {} as never, // procesar está inyectado: los puertos no se tocan
    enviar,
    marcarLeido,
    procesar,
  });
  return { adaptador, espias };
}

describe("el bucle del adaptador", () => {
  it("marca leído, procesa y envía los salientes en orden", async () => {
    const { adaptador, espias } = armar();
    await adaptador.alLlegar(entrega(mensajeDeTexto("wamid.1", "hola")), {});

    assert.deepEqual(espias.leidos, ["wamid.1"]);
    assert.deepEqual(espias.procesados, ["hola"]);
    assert.equal(espias.enviados.length, 2);
    assert.equal(espias.enviados[0]!.texto, "primera parte");
    assert.equal(espias.enviados[1]!.tipo, "botones");
    adaptador.detener();
  });

  it("si marcar leído falla, la respuesta sale igual", async () => {
    const { adaptador, espias } = armar({ marcarLeidoFalla: true });
    await adaptador.alLlegar(entrega(mensajeDeTexto("wamid.2", "hola")), {});
    assert.equal(espias.enviados.length, 2, "el typing es cortesía, no requisito");
    adaptador.detener();
  });

  it("un duplicado no envía nada", async () => {
    const { adaptador, espias } = armar({
      procesarImpl: async () => ({
        salientes: [],
        conversacionId: "conv-1",
        origenRespuesta: "fallback" as const,
        flujoActivo: null,
        efectos: [],
        quitarBotones: false,
        duplicado: true,
      }),
    });
    await adaptador.alLlegar(entrega(mensajeDeTexto("wamid.3", "hola")), {});
    assert.equal(espias.enviados.length, 0);
    adaptador.detener();
  });

  it("si procesar lanza, manda la disculpa y no propaga", async () => {
    const { adaptador, espias } = armar({
      procesarImpl: async () => {
        throw new Error("se rompió todo");
      },
    });
    await adaptador.alLlegar(entrega(mensajeDeTexto("wamid.4", "hola")), {});
    assert.equal(espias.enviados.length, 1);
    assert.match(espias.enviados[0]!.texto ?? "", /Tuve un problema/);
    adaptador.detener();
  });

  it("una reaction no llega a procesar", async () => {
    const { adaptador, espias } = armar();
    await adaptador.alLlegar(
      entrega({
        id: "wamid.5",
        de: "5493810000001",
        tipo: "reaction",
        nombre: null,
        timestamp: "",
        crudo: {},
      }),
      {},
    );
    assert.equal(espias.procesados.length, 0);
    assert.equal(espias.enviados.length, 0);
    adaptador.detener();
  });

  it("el fallo de UN envío corta ese mensaje pero no el resto de la entrega", async () => {
    const { adaptador, espias } = armar({ enviarFalla: (n) => n === 1 });
    await adaptador.alLlegar(
      entrega(mensajeDeTexto("wamid.6", "uno"), mensajeDeTexto("wamid.7", "dos", "5493810000002")),
      {},
    );
    // El primer mensaje perdió sus 2 envíos (el primero falló y cortó); el
    // segundo vecino recibió los suyos completos.
    assert.deepEqual(espias.procesados, ["uno", "dos"]);
    assert.ok(espias.enviados.every((e) => e.a === "5493810000002"));
    adaptador.detener();
  });

  it("excedido el límite de frecuencia: avisa y no procesa", async () => {
    const { adaptador, espias } = armar();
    const muchos = Array.from({ length: 21 }, (_, i) => mensajeDeTexto(`wamid.f${i}`, `m${i}`));
    await adaptador.alLlegar(entrega(...muchos), {});
    assert.equal(espias.procesados.length, 20, "el 21 no se procesa");
    const avisos = espias.enviados.filter((e) => /muy seguido/.test(e.texto ?? ""));
    assert.equal(avisos.length, 1);
    adaptador.detener();
  });
});
