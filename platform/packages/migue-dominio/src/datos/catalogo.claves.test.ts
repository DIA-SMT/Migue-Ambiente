/**
 * Que toda clave de `textos_bot` la lea alguien, y que el fixture las tenga todas.
 *
 * POR QUÉ EXISTE
 *
 * `separa_fuera_de_avenidas` estuvo en la base desde la migración 008, con el
 * texto que el área pidió explícitamente en el documento de QA, y NINGÚN archivo
 * la leía: el flujo de SEPARÁ mandaba una versión escrita a mano en el código. El
 * panel la ofrecía para editar, confirmaba «guardado, el bot lo usa desde el
 * próximo mensaje», y el vecino seguía recibiendo otra cosa. Un control roto que
 * no parece roto.
 *
 * LA PRIMERA VERSIÓN DE ESTE ARCHIVO NO SERVÍA, y vale la pena decir por qué:
 * recorría las claves de `catalogoPrueba()`. El fixture tenía 18 de las 21 de
 * producción, y justo la clave huérfana no estaba entre ellas — así que la prueba
 * daba verde sin haber mirado el caso que existía para detectar. Lo comprobé
 * reinstalando el bug: pasó igual.
 *
 * De ahí las DOS pruebas de abajo, y el orden importa:
 *
 *   1. Las claves salen de las MIGRACIONES, que es lo que define qué existe en
 *      producción. El fixture no puede ser la fuente de verdad de una prueba que
 *      busca desincronizaciones con la base.
 *   2. Y el fixture tiene que tenerlas todas, porque una clave que le falta hace
 *      que su rama NUNCA se ejecute en la suite. Ya pasó con
 *      `seguimiento_tras_responder`: se cambió el «¿te sirvió?» de texto suelto
 *      a dos botones y los 360 tests siguieron verdes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogoPrueba } from "../flujos/_fixtures.ts";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ_DOMINIO = join(AQUI, "..");
const MIGRACIONES = join(AQUI, "..", "..", "..", "..", "..", "db", "migraciones");

/**
 * Las claves que la base tiene, leídas de las migraciones.
 *
 * Se parsea el SQL en vez de mantener una lista acá: una lista propia es
 * exactamente el mecanismo que este archivo viene a vigilar. En este proyecto ya
 * se desincronizaron tres —los tipos de trabajo en `cola.ts`, las claves que
 * podían ir vacías en el panel, y el fixture del catálogo—.
 */
function clavesDeLaBase(): Set<string> {
  const claves = new Set<string>();
  for (const archivo of readdirSync(MIGRACIONES)) {
    if (!archivo.endsWith(".sql")) continue;
    const sql = readFileSync(join(MIGRACIONES, archivo), "utf8");

    // Sólo los bloques que insertan en `textos_bot`: otras tablas usan la misma
    // forma `('clave',` y contarlas daría claves inventadas.
    const bloques = sql.split(/insert\s+into\s+public\.textos_bot[^\n]*\n/i).slice(1);
    for (const bloque of bloques) {
      // El bloque termina en el `;` de la sentencia.
      const cuerpo = bloque.split(/;\s*$/m)[0] ?? "";
      for (const m of cuerpo.matchAll(/^\s*\('([a-z_]+)'\s*,/gm)) {
        claves.add(m[1]!);
      }
    }
  }
  return claves;
}

function fuentesDelDominio(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) {
      salida.push(...fuentesDelDominio(ruta));
      continue;
    }
    if (!entrada.endsWith(".ts")) continue;
    // Los fixtures y los tests quedan afuera: el fixture DECLARA las claves y
    // los tests las mencionan sin usarlas. Contarlos haría que la prueba pase
    // por el solo hecho de que la clave exista en algún lado, que es el bug.
    if (entrada.endsWith(".test.ts") || entrada === "_fixtures.ts") continue;
    salida.push(ruta);
  }
  return salida;
}

/**
 * Claves que a propósito no lee el dominio, con el motivo.
 *
 * El motivo va acá y no en un comentario suelto: es lo que distingue «decidimos
 * que esta clave todavía no se usa» de «se nos pasó».
 */
const NO_LAS_LEE_NADIE: ReadonlyMap<string, string> = new Map([
  [
    "despedida",
    "La lee el orquestador por una constante, no por su nombre literal. Verificado a mano.",
  ],
]);

describe("las claves de textos_bot", () => {
  it("la lista se pudo leer de las migraciones", () => {
    // Si el parseo devolviera vacío, las dos pruebas de abajo pasarían sin
    // mirar nada. Es el mismo modo de falla que tuvo la primera versión.
    const claves = clavesDeLaBase();
    assert.ok(
      claves.size >= 18,
      `sólo encontré ${claves.size} claves en las migraciones: el parseo se rompió`,
    );
  });

  it("todas las lee alguien del dominio", () => {
    const codigo = fuentesDelDominio(RAIZ_DOMINIO)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    const huerfanas: string[] = [];
    for (const clave of clavesDeLaBase()) {
      if (NO_LAS_LEE_NADIE.has(clave)) continue;
      // Entre comillas, que es como se la pasa a `leerTexto` o `tieneTexto`.
      // Suelta daría falso positivo con cualquier comentario que la nombre.
      if (!codigo.includes(`"${clave}"`) && !codigo.includes(`'${clave}'`)) {
        huerfanas.push(clave);
      }
    }

    assert.deepEqual(
      huerfanas.sort(),
      [],
      `estas claves se pueden editar desde el panel y el bot NO las lee, así que ` +
        `cambiarlas no modifica nada de lo que recibe un vecino`,
    );
  });

  it("el fixture tiene todas, o sus ramas no se ejecutan en la suite", () => {
    const enFixture = new Set(catalogoPrueba().textos.keys());
    const faltan = [...clavesDeLaBase()].filter((c) => !enFixture.has(c)).sort();

    assert.deepEqual(
      faltan,
      [],
      `el fixture no tiene estas claves, así que el código que las lee nunca corre ` +
        `en las pruebas: un cambio de comportamiento ahí pasa sin que nada lo note`,
    );
  });

  it("no quedan excepciones que ya no correspondan", () => {
    const claves = clavesDeLaBase();
    for (const [clave, motivo] of NO_LAS_LEE_NADIE) {
      assert.ok(
        claves.has(clave),
        `«${clave}» figura como excepción («${motivo}») y ya no existe en la base`,
      );
    }
  });
});
