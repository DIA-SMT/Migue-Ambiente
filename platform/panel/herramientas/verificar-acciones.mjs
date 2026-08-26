/*
 * Un módulo `"use server"` sólo puede exportar funciones async.
 *
 * Next convierte TODO lo que exporta un módulo así en una referencia al
 * servidor. Si exporta un arreglo o un objeto, el cliente recibe un proxy: el
 * `.map` no existe y la pantalla entera revienta al abrirla, con un error que
 * no dice nada del "use server".
 *
 * Ni `tsc` ni `next build` lo agarran — el tipo es correcto, la falla es en
 * tiempo de ejecución y sólo al renderizar. Ya rompió dos pantallas (Personal y
 * Puntos Verdes), así que ahora se verifica.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function archivos(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? archivos(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

const fallas = [];
for (const p of archivos("src")) {
  const texto = readFileSync(p, "utf8");
  if (!/^\s*["']use server["']/.test(texto)) continue;
  texto.split("\n").forEach((linea, i) => {
    const m = /^export\s+(const|let|var|class|enum)\s+([A-Za-z0-9_$]+)/.exec(linea);
    // `export const f = async (...)` sí es una acción válida.
    if (m && !/=\s*(async|\()/.test(linea)) {
      fallas.push(`${p}:${i + 1}  exporta «${m[2]}», que no es una función async`);
    }
  });
}

if (fallas.length) {
  console.log("Exportaciones que van a romper la pantalla al abrirla:\n");
  for (const f of fallas) console.log("  " + f);
  console.log("\nMovelas a un módulo común (por ejemplo src/lib/) e importalas desde ahí.");
  process.exit(1);
}
console.log("Las acciones sólo exportan funciones async.");
