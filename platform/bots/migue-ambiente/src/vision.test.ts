import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crearAnalizadorDeFotos } from "./vision.ts";
import type { descargarDeTelegram } from "./canal/telegram/descargar.ts";
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

const descargaOk: typeof descargarDeTelegram = async () => ({
  datos: new Uint8Array([1, 2, 3]),
  mime: "image/jpeg",
  nombre: "foto.jpg",
});

describe("crearAnalizadorDeFotos", () => {
  it("el camino feliz: descarga, evalúa y devuelve el veredicto", async () => {
    const analizar = crearAnalizadorDeFotos({
      token: "t",
      obtenerCatalogo: catalogoFalso(),
      descargar: descargaOk,
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("ref-0", { flujo: "retiro_no_habitual" });
    assert.deepEqual(v, VEREDICTO);
  });

  it("con modelo_vision vacío NO descarga nada: el interruptor va primero", async () => {
    let descargas = 0;
    const analizar = crearAnalizadorDeFotos({
      token: "t",
      obtenerCatalogo: catalogoFalso(""),
      descargar: async (r, t) => {
        descargas++;
        return descargaOk(r, t);
      },
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("ref-1", { flujo: "retiro_no_habitual" });
    assert.equal(v?.veredicto, "no_evaluada");
    assert.equal(descargas, 0, "no bajó ni un byte");
  });

  it("si la descarga lanza, devuelve no_evaluada sin propagar", async () => {
    const analizar = crearAnalizadorDeFotos({
      token: "t",
      obtenerCatalogo: catalogoFalso(),
      descargar: async () => {
        throw new Error("media vencida");
      },
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("ref-2", { flujo: "retiro_no_habitual" });
    assert.equal(v?.veredicto, "no_evaluada");
  });

  it("si la evaluación lanza, devuelve no_evaluada sin propagar", async () => {
    const evaluarRoto: typeof evaluarFoto = async () => {
      throw new Error("proveedor caído");
    };
    const analizar = crearAnalizadorDeFotos({
      token: "t",
      obtenerCatalogo: catalogoFalso(),
      descargar: descargaOk,
      evaluar: evaluarRoto,
    });
    const v = await analizar("ref-3", { flujo: "reclamo_recoleccion" });
    assert.equal(v?.veredicto, "no_evaluada");
  });

  it("si el catálogo no responde, tampoco lanza", async () => {
    const analizar = crearAnalizadorDeFotos({
      token: "t",
      obtenerCatalogo: async () => {
        throw new Error("Supabase caído");
      },
      descargar: descargaOk,
      evaluar: async () => VEREDICTO,
    });
    const v = await analizar("ref-4", { flujo: "retiro_no_habitual" });
    assert.equal(v?.veredicto, "no_evaluada");
  });
});
