import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CacheConVencimiento } from "./cache.ts";

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CacheConVencimiento", () => {
  it("carga una vez y después sirve de memoria", async () => {
    let cargas = 0;
    const cache = new CacheConVencimiento(async () => ++cargas, { ttlMs: 1000 });

    assert.equal(await cache.obtener(), 1);
    assert.equal(await cache.obtener(), 1);
    assert.equal(await cache.obtener(), 1);
    assert.equal(cargas, 1, "sólo debería haber cargado una vez");
  });

  it("recarga cuando vence el TTL", async () => {
    let cargas = 0;
    const cache = new CacheConVencimiento(async () => ++cargas, { ttlMs: 20 });

    assert.equal(await cache.obtener(), 1);
    await esperar(30);
    assert.equal(await cache.obtener(), 2, "tras vencer debe recargar");
  });

  it("coalesce las cargas simultáneas en una sola consulta", async () => {
    // Esto es lo que evita que un bot recién arrancado, con veinte mensajes
    // encolados, dispare veinte consultas idénticas a la misma tabla.
    let cargas = 0;
    const cache = new CacheConVencimiento(
      async () => {
        cargas++;
        await esperar(20);
        return cargas;
      },
      { ttlMs: 1000 },
    );

    const resultados = await Promise.all(Array.from({ length: 20 }, () => cache.obtener()));

    assert.equal(cargas, 1, `se cargó ${cargas} veces, debería ser 1`);
    assert.deepEqual(new Set(resultados), new Set([1]), "todos reciben el mismo valor");
  });

  it("sirve el valor viejo si la recarga falla", async () => {
    // Ante una caída momentánea de Supabase, seguir respondiendo con reglas de
    // hace dos minutos es mejor que dejar de responderle a los vecinos.
    let intentos = 0;
    const cache = new CacheConVencimiento(
      async () => {
        intentos++;
        if (intentos === 1) return "reglas buenas";
        throw new Error("Supabase no responde");
      },
      { ttlMs: 10 },
    );

    assert.equal(await cache.obtener(), "reglas buenas");
    await esperar(20);
    assert.equal(await cache.obtener(), "reglas buenas", "debe servir el valor viejo");
    assert.equal(intentos, 2, "y haber intentado recargar");
  });

  it("vuelve a intentar la recarga en cada pedido mientras falla", async () => {
    // No se refresca `cargadoEn` al servir un valor viejo, así que no queda
    // pegado sirviendo datos rancios durante todo un TTL más.
    let intentos = 0;
    const cache = new CacheConVencimiento(
      async () => {
        intentos++;
        if (intentos === 1) return "ok";
        throw new Error("falla");
      },
      { ttlMs: 10 },
    );

    await cache.obtener();
    await esperar(20);
    await cache.obtener();
    await cache.obtener();
    assert.equal(intentos, 3, "cada pedido con caché vencida debe reintentar");
  });

  it("propaga el error si nunca hubo un valor válido", async () => {
    const cache = new CacheConVencimiento(
      async () => {
        throw new Error("Supabase no responde");
      },
      { ttlMs: 1000 },
    );

    await assert.rejects(() => cache.obtener(), /Supabase no responde/);
  });

  it("propaga el error si se configuró no servir vencido", async () => {
    let intentos = 0;
    const cache = new CacheConVencimiento(
      async () => {
        intentos++;
        if (intentos === 1) return "ok";
        throw new Error("falla");
      },
      { ttlMs: 10, servirVencidoSiFalla: false },
    );

    assert.equal(await cache.obtener(), "ok");
    await esperar(20);
    await assert.rejects(() => cache.obtener(), /falla/);
  });

  it("invalidar fuerza la recarga sin perder el respaldo", async () => {
    let cargas = 0;
    const cache = new CacheConVencimiento(async () => ++cargas, { ttlMs: 10_000 });

    assert.equal(await cache.obtener(), 1);
    cache.invalidar();
    assert.equal(await cache.obtener(), 2);
  });

  it("vaciar descarta el respaldo, así el próximo fallo se propaga", async () => {
    let intentos = 0;
    const cache = new CacheConVencimiento(
      async () => {
        intentos++;
        if (intentos === 1) return "ok";
        throw new Error("falla");
      },
      { ttlMs: 10_000 },
    );

    assert.equal(await cache.obtener(), "ok");
    cache.vaciar();
    await assert.rejects(() => cache.obtener(), /falla/);
  });

  it("una carga que falla no deja la coalescencia trabada", async () => {
    // Si `#enVuelo` no se limpiara, un fallo transitorio dejaría el caché
    // devolviendo para siempre la misma promesa rechazada.
    let intentos = 0;
    const cache = new CacheConVencimiento(
      async () => {
        intentos++;
        if (intentos <= 2) throw new Error("falla transitoria");
        return "recuperado";
      },
      { ttlMs: 1000 },
    );

    await assert.rejects(() => cache.obtener());
    await assert.rejects(() => cache.obtener());
    assert.equal(await cache.obtener(), "recuperado");
  });

  it("expone si está vencido", async () => {
    const cache = new CacheConVencimiento(async () => "x", { ttlMs: 20 });
    assert.equal(cache.vencido, true, "sin cargar está vencido");
    await cache.obtener();
    assert.equal(cache.vencido, false);
    await esperar(30);
    assert.equal(cache.vencido, true);
  });
});
