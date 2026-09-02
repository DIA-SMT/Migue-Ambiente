import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluarFoto,
  instruccionesDeVision,
  parsearVeredicto,
  VEREDICTO_NO_EVALUADO,
} from "./vision.ts";
import { catalogoPrueba } from "../flujos/_fixtures.ts";
import type { chat, RespuestaChat } from "./cliente.ts";

const IMAGEN = { datos: new Uint8Array([1, 2, 3]), mime: "image/jpeg" };
const CTX = { flujo: "retiro_no_habitual" } as const;

/** Un `chat` falso que devuelve el texto dado, o lanza. */
function llamadaFalsa(texto: string | Error): typeof chat {
  return async (): Promise<RespuestaChat> => {
    if (texto instanceof Error) throw texto;
    return { texto, modelo: "falso", tokensEntrada: 1, tokensSalida: 1, costoUsd: 0, latenciaMs: 1 };
  };
}

describe("parsearVeredicto", () => {
  it("acepta el contrato completo", () => {
    const v = parsearVeredicto(
      '{"veredicto":"valida","categoria":"rnh","detalle":"bolsas de escombro frente a una casa"}',
    );
    assert.deepEqual(v, {
      veredicto: "valida",
      categoria: "rnh",
      detalle: "bolsas de escombro frente a una casa",
    });
  });

  it("una categoría inventada degrada a null sin tirar el veredicto", () => {
    const v = parsearVeredicto('{"veredicto":"dudosa","categoria":"cosas","detalle":"x"}');
    assert.equal(v.veredicto, "dudosa");
    assert.equal(v.categoria, null);
  });

  it("un veredicto inventado degrada a no_evaluada", () => {
    assert.deepEqual(
      parsearVeredicto('{"veredicto":"aprobadisima","categoria":"rnh","detalle":"x"}'),
      VEREDICTO_NO_EVALUADO,
    );
  });

  it("el modelo no puede decir no_evaluada: es NUESTRO estado de fallo", () => {
    assert.deepEqual(
      parsearVeredicto('{"veredicto":"no_evaluada","categoria":null,"detalle":"x"}'),
      VEREDICTO_NO_EVALUADO,
    );
  });

  it("JSON roto degrada a no_evaluada, nunca lanza", () => {
    assert.deepEqual(parsearVeredicto("esto no es json {"), VEREDICTO_NO_EVALUADO);
  });

  it("el detalle se recorta", () => {
    const v = parsearVeredicto(
      `{"veredicto":"valida","categoria":"rnh","detalle":"${"x".repeat(500)}"}`,
    );
    assert.ok((v.detalle ?? "").length <= 300);
  });
});

describe("instruccionesDeVision", () => {
  it("tiene las seis categorías y el contrato JSON", () => {
    const p = instruccionesDeVision(CTX);
    for (const c of ["basural", "volcadero", "rnh", "barrido", "limpieza_cestos", "otros"]) {
      assert.ok(p.includes(c), `falta la categoría ${c}`);
    }
    assert.ok(p.includes('"veredicto"'), "falta el contrato JSON");
  });

  it("nombra el trámite que corresponde", () => {
    assert.match(instruccionesDeVision(CTX), /retiro de residuos no habituales/);
    assert.match(
      instruccionesDeVision({ flujo: "reclamo_recoleccion" }),
      /falta de recolección/,
    );
  });
});

describe("evaluarFoto", () => {
  it("con el modelo caído devuelve no_evaluada, no lanza", async () => {
    const v = await evaluarFoto(IMAGEN, CTX, catalogoPrueba(), llamadaFalsa(new Error("502")));
    assert.deepEqual(v, VEREDICTO_NO_EVALUADO);
  });

  it("con modelo_vision vacío NO llama a nada: es el interruptor del panel", async () => {
    const config = new Map(catalogoPrueba().configuracion);
    config.set("modelo_vision", "");
    let llamadas = 0;
    const espia: typeof chat = async () => {
      llamadas++;
      throw new Error("no debería llamarse");
    };
    const v = await evaluarFoto(IMAGEN, CTX, catalogoPrueba({ configuracion: config }), espia);
    assert.deepEqual(v, VEREDICTO_NO_EVALUADO);
    assert.equal(llamadas, 0);
  });

  it("una imagen absurda de grande no se manda", async () => {
    let llamadas = 0;
    const espia: typeof chat = async () => {
      llamadas++;
      throw new Error("no debería llamarse");
    };
    const gigante = { datos: new Uint8Array(9 * 1024 * 1024), mime: "image/jpeg" };
    const v = await evaluarFoto(gigante, CTX, catalogoPrueba(), espia);
    assert.deepEqual(v, VEREDICTO_NO_EVALUADO);
    assert.equal(llamadas, 0);
  });

  it("el camino feliz devuelve lo que el modelo vio", async () => {
    const v = await evaluarFoto(
      IMAGEN,
      CTX,
      catalogoPrueba(),
      llamadaFalsa('{"veredicto":"no_corresponde","categoria":null,"detalle":"es una selfie"}'),
    );
    assert.equal(v.veredicto, "no_corresponde");
    assert.equal(v.detalle, "es una selfie");
  });
});
