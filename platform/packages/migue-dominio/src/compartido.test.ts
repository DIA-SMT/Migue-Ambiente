import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claveDeStorage, formatoDe, interpolar, mimeDe } from "./compartido.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/**
 * Recorre el grafo de imports desde un archivo, siguiendo sólo los relativos, y
 * junta todos los especificadores que NO son relativos.
 *
 * Se hace estáticamente y no cargando los módulos porque es la única forma de
 * ver qué terminaría en un bundle: `import` en tiempo de ejecución no distingue
 * entre lo que el empaquetador incluye y lo que no.
 */
function dependenciasExternas(entrada: string): { externas: Set<string>; visitados: string[] } {
  const externas = new Set<string>();
  const visitados: string[] = [];
  const pendientes = [entrada];

  while (pendientes.length > 0) {
    const archivo = pendientes.pop()!;
    if (visitados.includes(archivo)) continue;
    visitados.push(archivo);

    const fuente = fs.readFileSync(archivo, "utf8");
    // Cubre `import ... from "x"`, `export ... from "x"` y `import("x")`.
    const patron = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

    for (const coincidencia of fuente.matchAll(patron)) {
      const especificador = coincidencia[1] ?? coincidencia[2];
      if (especificador === undefined) continue;

      if (especificador.startsWith(".")) {
        pendientes.push(path.resolve(path.dirname(archivo), especificador));
      } else {
        externas.add(especificador);
      }
    }
  }

  return { externas, visitados };
}

describe("el módulo compartido puede correr en el navegador", () => {
  it("no arrastra módulos de Node ni paquetes pesados", () => {
    // El panel es Next.js y parte de su código va al cliente. Si este módulo
    // importara `node:crypto` el bundle no compila, y si importara `pdfjs-dist`
    // sumaría megabytes de un extractor de PDF que en el navegador no se usa.
    //
    // El antecedente: `formatoDe` vivía en `extraer.ts`, que importa pdf.ts,
    // docx.ts y node:crypto. Importarlo desde el panel traía todo eso.
    const { externas, visitados } = dependenciasExternas(path.join(AQUI, "compartido.ts"));

    assert.ok(visitados.length >= 4, `sólo recorrió ${visitados.length} archivos, revisar el parser`);

    const prohibidas = [...externas].filter(
      (e) =>
        e.startsWith("node:") ||
        e === "pdfjs-dist" ||
        e.startsWith("pdfjs-dist/") ||
        e === "fflate" ||
        e === "@supabase/supabase-js",
    );

    assert.deepEqual(
      prohibidas,
      [],
      `compartido.ts llega a ${prohibidas.join(", ")} por: ${visitados
        .map((v) => path.relative(AQUI, v))
        .join(" -> ")}`,
    );
  });

  it("de hecho no depende de NADA externo", () => {
    // Hoy es así y conviene que se note si deja de serlo: cualquier dependencia
    // nueva acá se paga en el bundle del panel.
    const { externas } = dependenciasExternas(path.join(AQUI, "compartido.ts"));
    assert.deepEqual([...externas], []);
  });

  it("el detector de dependencias funciona de verdad", () => {
    // Sin esto, un parser roto haría pasar los dos tests de arriba por no
    // encontrar nada. Se lo apunta a un módulo que SÍ importa pdfjs.
    const { externas } = dependenciasExternas(path.join(AQUI, "ingesta", "extraer.ts"));
    assert.ok(
      [...externas].some((e) => e.startsWith("pdfjs-dist")),
      `no detectó pdfjs-dist en extraer.ts; encontró: ${[...externas].join(", ")}`,
    );
    assert.ok([...externas].includes("node:crypto"));
  });
});

describe("lo que el panel comparte con el bot", () => {
  it("claveDeStorage da el mismo resultado que usa el worker", () => {
    // Es el contrato: el panel arma la clave al subir, el worker la usa al
    // bajar. Si divergieran, el archivo se sube a una ruta que el worker no
    // encuentra y el documento nunca se indexa, sin error visible.
    const hash = "c8114c85aaaabbbbccccddddeeeeffff00001111222233334444555566667777";
    assert.equal(claveDeStorage("Documento sin título.docx", hash), "c8114c85-Documento-sin-titulo.docx");
  });

  it("formatoDe y mimeDe sirven para validar una subida", () => {
    assert.equal(formatoDe("Ordenanza.PDF"), "pdf");
    assert.equal(mimeDe("pdf"), "application/pdf");
    assert.equal(
      mimeDe("docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("interpolar resuelve los marcadores igual que al enviar el mensaje", () => {
    // El panel lo usa para previsualizar un texto de `textos_bot`. Si no fuera
    // la misma función, la vista previa mentiría.
    assert.equal(
      interpolar("El plazo es de {plazo} y lo retira {empresa}.", {
        plazo: "72 hs hábiles",
        empresa: "Transporte 9 de Julio",
      }),
      "El plazo es de 72 hs hábiles y lo retira Transporte 9 de Julio.",
    );
  });
});
