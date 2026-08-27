import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { descripcionDeError } from "./errores.ts";

describe("descripcionDeError", () => {
  test("el error de Supabase deja de ser [object Object]", () => {
    // Esto es literalmente lo que tiró la base el 26/08 y lo que el log se
    // tragó. `PostgrestError` es un objeto plano, no una Error.
    const postgrest = {
      message: "function public.conversaciones_para_encuestar does not exist",
      code: "PGRST202",
      details: null,
      hint: "Perhaps you meant to call another function",
    };
    const texto = descripcionDeError(postgrest);
    assert.notEqual(texto, "[object Object]");
    assert.match(texto, /conversaciones_para_encuestar/);
    assert.match(texto, /PGRST202/);
    assert.match(texto, /Perhaps you meant/);
  });

  test("los campos vacíos o nulos del error de Supabase no ensucian", () => {
    const texto = descripcionDeError({ message: "no anda", code: "", details: null, hint: null });
    assert.equal(texto, "no anda");
  });

  test("una Error común da su mensaje", () => {
    assert.equal(descripcionDeError(new Error("se cayó")), "se cayó");
  });

  test("una Error sin mensaje da su nombre, no una cadena vacía", () => {
    assert.equal(descripcionDeError(new TypeError("")), "TypeError");
  });

  test("suma la causa, que es donde fetch deja el motivo real", () => {
    const error = new Error("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:6379") });
    const texto = descripcionDeError(error);
    assert.match(texto, /fetch failed/);
    assert.match(texto, /ECONNREFUSED/);
  });

  test("no repite la causa si el mensaje ya la contiene", () => {
    const error = new Error("falló: ya está", { cause: new Error("ya está") });
    assert.equal(descripcionDeError(error), "falló: ya está");
  });

  test("una cadena pasa tal cual", () => {
    assert.equal(descripcionDeError("timeout de 2500ms"), "timeout de 2500ms");
  });

  test("un objeto cualquiera se serializa en vez de perderse", () => {
    assert.equal(descripcionDeError({ estado: 503 }), '{"estado":503}');
  });

  test("una referencia circular no explota", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["yo"] = circular;
    assert.match(descripcionDeError(circular), /sin descripción/);
  });

  test("nunca devuelve vacío, ni con null, undefined o {}", () => {
    for (const valor of [null, undefined, {}, ""]) {
      const texto = descripcionDeError(valor);
      assert.notEqual(texto.trim(), "", `devolvió vacío para ${JSON.stringify(valor)}`);
      assert.notEqual(texto, "[object Object]");
    }
  });
});
