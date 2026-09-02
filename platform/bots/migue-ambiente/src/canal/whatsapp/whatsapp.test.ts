import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startHttpServer } from "@bots/core";
import { abrirEntrega, rutasDelWebhook, type Entrega } from "./webhook.ts";
import { desafioDeAlta, firmaValida } from "./verificar.ts";

const SECRETO = "un-app-secret-de-mentira";
const TOKEN = "token-de-alta-de-mentira";
const RUTA = "/hooks/whatsapp";

/** La firma tal como la arma Meta, para no repetir el HMAC en cada prueba. */
function firmar(crudo: string | Buffer, secreto = SECRETO): string {
  return "sha256=" + createHmac("sha256", secreto).update(crudo).digest("hex");
}

/** Un sobre de Meta con un mensaje de texto adentro. */
function sobre(mensajes: unknown[], estados: unknown[] = []): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_DE_MENTIRA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "543810000000", phone_number_id: "PNID" },
              contacts: [{ profile: { name: "Ana" }, wa_id: "5493810000001" }],
              messages: mensajes,
              statuses: estados,
            },
          },
        ],
      },
    ],
  };
}

const MENSAJE_TEXTO = {
  from: "5493810000001",
  id: "wamid.UNO",
  timestamp: "1787000000",
  type: "text",
  text: { body: "necesito un retiro" },
};

// ---------------------------------------------------------------------------
// La firma
// ---------------------------------------------------------------------------

describe("firmaValida", () => {
  const cuerpo = Buffer.from('{"hola":"mundo"}', "utf8");

  it("acepta la firma que corresponde", () => {
    assert.equal(firmaValida(cuerpo, firmar(cuerpo), SECRETO), true);
  });

  it("rechaza una firma hecha con otro secreto", () => {
    assert.equal(firmaValida(cuerpo, firmar(cuerpo, "otro"), SECRETO), false);
  });

  it("rechaza si el cuerpo cambió un solo byte", () => {
    const firma = firmar(cuerpo);
    assert.equal(firmaValida(Buffer.from('{"hola":"munda"}', "utf8"), firma, SECRETO), false);
  });

  it("rechaza sin cabecera, sin prefijo y con secreto vacío", () => {
    assert.equal(firmaValida(cuerpo, undefined, SECRETO), false);
    assert.equal(firmaValida(cuerpo, "", SECRETO), false);
    const soloHex = firmar(cuerpo).slice("sha256=".length);
    assert.equal(firmaValida(cuerpo, soloHex, SECRETO), false);
    assert.equal(firmaValida(cuerpo, firmar(cuerpo), ""), false);
  });

  it("acepta el hexadecimal en mayúsculas", () => {
    const gritada = firmar(cuerpo).toUpperCase();
    assert.equal(firmaValida(cuerpo, gritada, SECRETO), true);
  });

  it("no se cae si la firma tiene otro largo", () => {
    // `timingSafeEqual` lanza con buffers de distinto tamaño. Si esto explota
    // en vez de devolver false, un POST basura tira 500 y Meta reintenta.
    assert.equal(firmaValida(cuerpo, "sha256=abc", SECRETO), false);
  });

  /**
   * La prueba que justifica que el cuerpo viaje como Buffer hasta acá.
   *
   * Es EXACTAMENTE el error que rompe esta integración: se toma el JSON ya
   * interpretado, se vuelve a serializar para firmarlo, y como el original
   * traía un espacio después de los dos puntos, el HMAC da otra cosa. En
   * pruebas no se nota —los sobres de ejemplo se escriben compactos— y en
   * producción se rechazan todos los mensajes.
   */
  it("la firma NO sobrevive a reserializar el JSON", () => {
    const comoLlego = '{"texto": "Ramírez", "n": 1}';
    const firma = firmar(comoLlego);
    const reserializado = JSON.stringify(JSON.parse(comoLlego));

    assert.notEqual(comoLlego, reserializado);
    assert.equal(firmaValida(Buffer.from(comoLlego, "utf8"), firma, SECRETO), true);
    assert.equal(firmaValida(Buffer.from(reserializado, "utf8"), firma, SECRETO), false);
  });
});

// ---------------------------------------------------------------------------
// El alta
// ---------------------------------------------------------------------------

describe("desafioDeAlta", () => {
  const consulta = (partes: Record<string, string>) => new URLSearchParams(partes);

  it("devuelve el desafío cuando el token coincide", () => {
    const q = consulta({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "1234" });
    assert.equal(desafioDeAlta(q, TOKEN), "1234");
  });

  it("devuelve null si el token no coincide", () => {
    const q = consulta({ "hub.mode": "subscribe", "hub.verify_token": "cualquiera", "hub.challenge": "1234" });
    assert.equal(desafioDeAlta(q, TOKEN), null);
  });

  it("devuelve null si no es un alta", () => {
    const q = consulta({ "hub.mode": "unsubscribe", "hub.verify_token": TOKEN, "hub.challenge": "1234" });
    assert.equal(desafioDeAlta(q, TOKEN), null);
  });

  it("devuelve null si falta el desafío o el token esperado está vacío", () => {
    assert.equal(desafioDeAlta(consulta({ "hub.mode": "subscribe", "hub.verify_token": TOKEN }), TOKEN), null);
    const completa = consulta({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1234" });
    assert.equal(desafioDeAlta(completa, ""), null);
  });
});

// ---------------------------------------------------------------------------
// Abrir el sobre
// ---------------------------------------------------------------------------

describe("abrirEntrega", () => {
  it("saca un mensaje de texto, completo", () => {
    const e = abrirEntrega(sobre([MENSAJE_TEXTO]));
    assert.equal(e.mensajes.length, 1);
    assert.deepEqual(e.mensajes[0], {
      id: "wamid.UNO",
      de: "5493810000001",
      tipo: "text",
      // El nombre sale del contacts[] que coincide con el from.
      nombre: "Ana",
      timestamp: "1787000000",
      // El objeto del mensaje viaja tal cual: el normalizador lo traduce.
      crudo: MENSAJE_TEXTO,
    });
    assert.equal(e.estados, 0);
  });

  it("sin contacts el nombre queda null", () => {
    const s = sobre([MENSAJE_TEXTO]) as {
      entry: Array<{ changes: Array<{ value: Record<string, unknown> }> }>;
    };
    delete s.entry[0]!.changes[0]!.value["contacts"];
    const e = abrirEntrega(s);
    assert.equal(e.mensajes[0]?.nombre, null);
  });

  it("el contacto se aparea por wa_id: otro vecino no hereda el nombre", () => {
    const e = abrirEntrega(sobre([{ ...MENSAJE_TEXTO, from: "5493810000099" }]));
    assert.equal(e.mensajes[0]?.nombre, null, "el contacts[] es de otro número");
  });

  it("junta los mensajes de varias entradas, no sólo de la primera", () => {
    // Dos vecinos escribiendo en el mismo segundo. Leer `entry[0]` a secas
    // funciona en las pruebas y pierde el segundo mensaje en producción.
    const uno = sobre([MENSAJE_TEXTO]) as { entry: unknown[] };
    const dos = sobre([{ ...MENSAJE_TEXTO, id: "wamid.DOS", from: "5493810000002" }]) as {
      entry: unknown[];
    };
    const e = abrirEntrega({ entry: [...uno.entry, ...dos.entry] });

    assert.deepEqual(
      e.mensajes.map((m) => m.id),
      ["wamid.UNO", "wamid.DOS"],
    );
  });

  it("cuenta los avisos de estado aparte y NO los toma por mensajes", () => {
    const e = abrirEntrega(sobre([], [{ id: "wamid.UNO", status: "read" }, { status: "delivered" }]));
    assert.equal(e.mensajes.length, 0);
    assert.equal(e.estados, 2);
  });

  it("ignora un mensaje sin id, porque no se puede deduplicar", () => {
    const e = abrirEntrega(sobre([{ from: "549381", type: "text" }, MENSAJE_TEXTO]));
    assert.deepEqual(
      e.mensajes.map((m) => m.id),
      ["wamid.UNO"],
    );
  });

  it("aguanta sobres rotos sin lanzar", () => {
    for (const basura of [null, undefined, {}, [], "texto", { entry: "no es lista" }, { entry: [null] }]) {
      const e = abrirEntrega(basura);
      assert.equal(e.mensajes.length, 0);
      assert.equal(e.estados, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// El servidor entero, contra un puerto de verdad
// ---------------------------------------------------------------------------

describe("el webhook montado", () => {
  let servidor: Server;
  let base: string;
  let recibidas: Entrega[] = [];
  let hacerFallar = false;

  before(async () => {
    servidor = (await startHttpServer({
      port: 0,
      routes: rutasDelWebhook({
        ruta: RUTA,
        tokenVerificacion: TOKEN,
        secretoApp: SECRETO,
        alLlegar: (entrega) => {
          if (hacerFallar) throw new Error("se rompió a propósito");
          recibidas.push(entrega);
        },
      }),
    })) as Server;

    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });

  after(() => {
    servidor.close();
  });

  /** POST con la firma bien hecha, que es el camino feliz. */
  async function postear(cuerpo: unknown, firma?: string): Promise<Response> {
    const crudo = JSON.stringify(cuerpo);
    return fetch(base + RUTA, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": firma ?? firmar(crudo),
      },
      body: crudo,
    });
  }

  it("el alta devuelve el desafío tal cual, en texto plano", async () => {
    const r = await fetch(
      `${base}${RUTA}?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=987654`,
    );
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "987654");
  });

  it("el alta con el token equivocado da 403", async () => {
    const r = await fetch(`${base}${RUTA}?hub.mode=subscribe&hub.verify_token=no&hub.challenge=1`);
    assert.equal(r.status, 403);
  });

  it("un mensaje firmado da 200 y llega al proceso", async () => {
    recibidas = [];
    const r = await postear(sobre([MENSAJE_TEXTO]));
    assert.equal(r.status, 200);

    // El 200 sale ANTES de procesar, así que hay que darle un turno al bucle.
    await new Promise((listo) => setImmediate(listo));
    assert.equal(recibidas.length, 1);
    assert.equal(recibidas[0]?.mensajes[0]?.id, "wamid.UNO");
  });

  it("un mensaje con firma inválida da 403 y NO se procesa", async () => {
    recibidas = [];
    const r = await postear(sobre([MENSAJE_TEXTO]), firmar("otra cosa"));
    assert.equal(r.status, 403);

    await new Promise((listo) => setImmediate(listo));
    assert.equal(recibidas.length, 0);
  });

  it("sin la cabecera de firma da 403", async () => {
    const crudo = JSON.stringify(sobre([MENSAJE_TEXTO]));
    const r = await fetch(base + RUTA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: crudo,
    });
    assert.equal(r.status, 403);
  });

  it("si el proceso falla, el 200 ya salió y no cambia", async () => {
    // Regla 3: Meta no tiene por qué reintentar porque algo se rompió de este
    // lado. Un 500 acá es una tormenta de reintentos garantizada.
    hacerFallar = true;
    try {
      const r = await postear(sobre([MENSAJE_TEXTO]));
      assert.equal(r.status, 200);
      await new Promise((listo) => setImmediate(listo));
    } finally {
      hacerFallar = false;
    }
  });

  it("un cuerpo que no es JSON da 400, no 500", async () => {
    const r = await fetch(base + RUTA, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": firmar("{") },
      body: "{",
    });
    assert.equal(r.status, 400);
  });

  it("otra ruta no existe", async () => {
    const r = await fetch(`${base}/otra-cosa`);
    assert.equal(r.status, 404);
  });
});
