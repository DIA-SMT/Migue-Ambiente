/**
 * Verifica que los dos temas del panel se puedan leer.
 *
 *   node herramientas/verificar-contraste.mjs
 *
 * No necesita base ni credenciales: lee `src/app/global.css`, saca los dos
 * bloques de variables y hace las cuentas.
 *
 * Existe porque el contraste es lo único de este cambio que no se ve al mirar
 * la pantalla si uno ya sabe qué dice el texto. Un aviso de error rojo sobre
 * rojo se lee igual de bien cuando uno escribió la frase; el que la lee por
 * primera vez, no. Y porque las tres relaciones que sostienen el tema están
 * escritas en un comentario, y un comentario no falla cuando alguien lo rompe.
 *
 * Lo que comprueba, que es exactamente lo que dice ese comentario:
 *
 *   1. `--papel` más claro que `--fondo` en los dos temas.
 *   2. `--hundida` más oscura que el papel en claro y MÁS CLARA en oscuro.
 *   3. Cada par `--X` / `--X-piso` a 4,5:1 o mejor, en los dos temas.
 *
 * Más el cuerpo de texto sobre papel y la tinta de la barra sobre el verde.
 *
 * El umbral es el de WCAG AA para texto normal (4,5:1). Para lo que es
 * decorativo o de trazo grueso se usa 3:1 y se dice cuál es cuál.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const aca = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aca, "..", "src", "app", "global.css"), "utf8");

/** Saca las variables de un bloque, respetando el orden de aparición. */
function bloque(selector) {
  const i = css.indexOf(selector);
  if (i === -1) throw new Error(`no encontré el bloque ${selector}`);
  const abre = css.indexOf("{", i);
  const cierra = css.indexOf("\n}", abre);
  const cuerpo = css.slice(abre, cierra);
  const vars = {};
  for (const m of cuerpo.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

const claro = bloque(":root {");
const oscuro = { ...claro, ...bloque(':root[data-tema="oscuro"] {') };

function aRgb(v) {
  const h = v.trim();
  if (!h.startsWith("#")) return null; // rgba() y demás: no se miden acá
  const c = h.slice(1);
  const full = c.length === 3 ? [...c].map((x) => x + x).join("") : c;
  if (full.length < 6) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);

function contraste(a, b) {
  const ra = aRgb(a), rb = aRgb(b);
  if (!ra || !rb) return null;
  const la = lum(ra), lb = lum(rb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

let fallas = 0;
const mal = (m) => { console.log(`  MAL  ${m}`); fallas++; };
const bien = (m) => console.log(`  ok   ${m}`);

function exige(tema, vars, tinta, fondo, minimo, que) {
  const r = contraste(vars[tinta], vars[fondo]);
  if (r === null) {
    console.log(`  --   ${tema}: ${tinta} sobre ${fondo} no se puede medir (no es hex)`);
    return;
  }
  const txt = `${tema}: ${que} — ${r.toFixed(2)}:1 (mínimo ${minimo})`;
  if (r >= minimo) bien(txt); else mal(txt);
}

for (const [tema, vars] of [["claro", claro], ["oscuro", oscuro]]) {
  console.log(`\n--- tema ${tema} ---`);

  // 1 · el papel se despega del fondo
  const lpapel = lum(aRgb(vars["papel"]));
  const lfondo = lum(aRgb(vars["fondo"]));
  if (lpapel > lfondo) bien(`${tema}: el papel es más claro que el fondo`);
  else mal(`${tema}: el papel NO es más claro que el fondo — las tarjetas se hunden`);

  // 2 · la superficie hundida cambia de lado según el tema
  const lhund = lum(aRgb(vars["hundida"]));
  if (tema === "claro" && lhund <= lpapel) bien("claro: la superficie hundida se hunde bajo el papel");
  else if (tema === "oscuro" && lhund > lpapel) bien("oscuro: la superficie hundida es más clara que el papel");
  else mal(`${tema}: la superficie hundida está del lado equivocado del papel — un thead en un pozo`);

  // 3 · cada par semántico contra su piso
  for (const base of ["ok", "curso", "pend", "alerta"]) {
    exige(tema, vars, base, `${base}-piso`, 4.5, `--${base} sobre --${base}-piso`);
  }
  exige(tema, vars, "azul-tinta", "azul-piso", 4.5, "--azul-tinta sobre --azul-piso (aviso info)");

  // cuerpo de texto sobre papel
  exige(tema, vars, "tinta", "papel", 4.5, "texto normal sobre papel");
  exige(tema, vars, "tinta-media", "papel", 4.5, "texto secundario sobre papel");
  exige(tema, vars, "tinta-suave", "papel", 4.5, "texto terciario sobre papel");
  exige(tema, vars, "tinta-fuerte", "papel", 4.5, "los números grandes del tablero");

  // la línea tiene que verse: no es texto, alcanza con que se distinga
  exige(tema, vars, "linea", "papel", 1.25, "el borde de una tarjeta contra el papel");

  // la barra: es verde profundo en los dos temas, así que esto no debería mover
  exige(tema, vars, "sobre-verde", "verde-profundo", 4.5, "la tinta de la barra sobre el verde");
  exige(tema, vars, "verde-acento", "verde-profundo", 4.5, "la palabra «Ambiente» de la marca");
  // Los enlaces se miden contra las DOS superficies sobre las que aparecen. La
  // del fondo de página es la que falla primero y es la que se olvida: un
  // enlace suelto en un párrafo fuera de una tarjeta.
  exige(tema, vars, "azul-enlace", "papel", 4.5, "un enlace sobre una tarjeta");
  exige(tema, vars, "azul-enlace", "fondo", 4.5, "un enlace sobre el fondo de la página");
  exige(tema, vars, "sobre-verde-fuerte", "verde-medio", 4.5, "el ítem activo del menú");
}

console.log(fallas === 0 ? "\nTodo legible." : `\n${fallas} par(es) por debajo del mínimo.`);
process.exit(fallas === 0 ? 0 : 1);
