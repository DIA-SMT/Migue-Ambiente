import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crearAnalizadorDeFotos } from "./vision.ts";
import type { descargarDeTelegram } from "./canal/telegram/descargar.ts";
import type { descargarDeWhatsApp } from "./canal/whatsapp/descargar.ts";
import type { evaluarFoto, obtenerCatalogo, Catalogo } from "@migue/dominio";

const VEREDICTO = {
  veredicto: "valida",
  categoria: "rnh",
  detalle: "escombros embolsados",
} as const;

/** Un catálogo mínimo: sólo lo que mira el analizador (modelo_vision). */
function catalogoFalso(modeloVision = "anthropic/claude-haiku-4.5"): typeof obtenerCatalogo {
  const catalogo = {
    configuracion: new Map<string, unknown>([["modelo_vision", modeloVision]]),
    textos: new Map<string, string>(),
    reglasExclusion: [],
    limitesVolumen: [],
    puntosVerdes: [],
    zonas: [],
    respuestasFijas: [],
  } as unknown as Catalogo;
  return async () => catalogo;
}

const bajadaOk = { datos: new Uint8Array([1, 2, 3]), mime: "image/jpeg", nombre: "foto.jpg" };
const descargaTelegramOk: typeof descargarDeTelegram = async () => bajadaOk;
const descargaWhatsAppOk: typeof descargarDeWhatsApp = async () => bajadaOk;

const RETIRO_TG = { flujo: "retiro_no_habitual", canal: "telegram" } as const;

describe("crearAnalizadorDeFotos", () => {
  it("el camino feliz de Telegram: descarga, evalúa y devuelve el veredicto", async () => {
    const analizar = crearAnalizadorDeFotos({
      tokenTelegram: "t",
      obtenerCatalogo: catalogoFalso(),
      descargarTelegram: descargaTelegramOk,
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("ref-0", RETIRO_TG);
    assert.deepEqual(v, VEREDICTO);
  });

  it("con modelo_vision vacío NO descarga nada: el interruptor va primero", async () => {
    let descargas = 0;
    const analizar = crearAnalizadorDeFotos({
      tokenTelegram: "t",
      obtenerCatalogo: catalogoFalso(""),
      descargarTelegram: async (r: string, t: string) => {
        descargas++;
        return descargaTelegramOk(r, t);
      },
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("ref-1", RETIRO_TG);
    assert.equal(v?.veredicto, "no_evaluada");
    assert.equal(descargas, 0, "no bajó ni un byte");
  });

  it("si la descarga lanza, devuelve no_evaluada sin propagar", async () => {
    const analizar = crearAnalizadorDeFotos({
      tokenTelegram: "t",
      obtenerCatalogo: catalogoFalso(),
      descargarTelegram: async () => {
        throw new Error("media vencida");
      },
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("ref-2", RETIRO_TG);
    assert.equal(v?.veredicto, "no_evaluada");
  });

  it("si la evaluación lanza, devuelve no_evaluada sin propagar", async () => {
    const evaluarRoto: typeof evaluarFoto = async () => {
      throw new Error("proveedor caído");
    };
    const analizar = crearAnalizadorDeFotos({
      tokenTelegram: "t",
      obtenerCatalogo: catalogoFalso(),
      descargarTelegram: descargaTelegramOk,
      evaluar: evaluarRoto,
    });
    const v = await analizar("ref-3", { flujo: "reclamo_recoleccion", canal: "telegram" });
    assert.equal(v?.veredicto, "no_evaluada");
  });

  it("si el catálogo no responde, tampoco lanza", async () => {
    const analizar = crearAnalizadorDeFotos({
      tokenTelegram: "t",
      obtenerCatalogo: async () => {
        throw new Error("Supabase caído");
      },
      descargarTelegram: descargaTelegramOk,
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("ref-4", RETIRO_TG);
    assert.equal(v?.veredicto, "no_evaluada");
  });

  it("una foto de WhatsApp se baja con la descarga de WhatsApp", async () => {
    let porWhatsApp = 0;
    const analizar = crearAnalizadorDeFotos({
      tokenTelegram: "t",
      whatsapp: { token: "tok-wa" },
      obtenerCatalogo: catalogoFalso(),
      descargarTelegram: async () => {
        throw new Error("no debería usarse Telegram para esto");
      },
      descargarWhatsApp: async (r, o) => {
        porWhatsApp++;
        assert.equal(o.token, "tok-wa");
        return descargaWhatsAppOk(r, o);
      },
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("media-99", { flujo: "retiro_no_habitual", canal: "whatsapp" });
    assert.deepEqual(v, VEREDICTO);
    assert.equal(porWhatsApp, 1);
  });

  it("foto de WhatsApp sin credenciales: no_evaluada, sin descargar ni mentir", async () => {
    let descargas = 0;
    const analizar = crearAnalizadorDeFotos({
      tokenTelegram: "t",
      whatsapp: null,
      obtenerCatalogo: catalogoFalso(),
      descargarWhatsApp: async (r, o) => {
        descargas++;
        return descargaWhatsAppOk(r, o);
      },
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("media-100", { flujo: "retiro_no_habitual", canal: "whatsapp" });
    assert.equal(v?.veredicto, "no_evaluada");
    assert.equal(descargas, 0);
  });
});
