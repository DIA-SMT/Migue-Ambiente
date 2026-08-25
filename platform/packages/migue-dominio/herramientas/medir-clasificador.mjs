/**
 * Mide el clasificador contra frases reales, con el modelo de verdad.
 *
 *   cd platform/packages/migue-dominio
 *   node --env-file=../../../.env.local herramientas/medir-clasificador.mjs
 *
 * POR QUÉ EXISTE
 *
 * Un cambio de prompt sin medición es una corazonada. Y este cambio salió de un
 * caso concreto: la MISMA intención escrita de dos formas daba dos resultados
 * distintos en producción.
 *
 *   «Necesito una habilitación comercial para abrir mi negocio»
 *      -> consulta_libre, confianza 0.95
 *   «Necesito una habilitación comercial»
 *      -> no_entendido, confianza 0.2
 *
 * La causa no era el prompt sino la taxonomía: `no_entendido` significaba a la
 * vez «no se entiende» y «no es de ambiente», que son cosas opuestas —una se
 * arregla mostrando el menú y la otra derivando— así que el modelo dudaba entre
 * esa etiqueta y `consulta_libre`.
 *
 * De ahí `fuera_de_alcance`. Este script comprueba que la separación se sostenga
 * con muchas formas de decir lo mismo, incluidas las cortas, que son las que
 * fallaban.
 *
 * CUESTA PLATA: son llamadas reales al modelo. Con gpt-4o-mini y estas frases,
 * centavos.
 */
import { clasificar, decidir } from "../src/ia/router.ts";
import { catalogoPrueba } from "../src/flujos/_fixtures.ts";

const catalogo = catalogoPrueba();

/**
 * Cada caso es [frase, intención esperada].
 *
 * Los primeros dos son EXACTAMENTE los que fallaron en producción, uno largo y
 * uno corto. Si el arreglo sirve, los dos tienen que dar `fuera_de_alcance` con
 * confianza alta.
 */
const CASOS = [
  // Fuera de alcance: se entiende y no es de Ambiente
  ["Necesito una habilitación comercial para abrir mi negocio", "fuera_de_alcance"],
  ["Necesito una habilitación comercial", "fuera_de_alcance"],
  ["habilitacion comercial", "fuera_de_alcance"],
  ["quiero pagar el impuesto inmobiliario", "fuera_de_alcance"],
  ["donde saco la licencia de conducir", "fuera_de_alcance"],
  ["tengo una multa de tránsito", "fuera_de_alcance"],
  ["hay un bache enorme en mi calle", "fuera_de_alcance"],
  ["se cortó la luz en todo el barrio", "fuera_de_alcance"],
  ["necesito un turno en el hospital", "fuera_de_alcance"],
  ["quiero anotarme en una beca", "fuera_de_alcance"],

  // No se entiende
  ["asdfgh", "no_entendido"],
  ["...", "no_entendido"],
  ["a", "no_entendido"],

  // Consultas de Ambiente
  ["donde tiro el aceite usado de cocina", "consulta_libre"],
  ["cuando pasa el camión por mi barrio", "consulta_libre"],
  ["que se puede llevar a un punto verde", "consulta_libre"],
  ["los puntos verdes atienden los domingos", "consulta_libre"],
  ["se puede reciclar telgopor", "consulta_libre"],

  // Trámites
  ["necesito que retiren unos escombros", "retiro_no_habitual"],
  ["quiero pedir un retiro", "retiro_no_habitual"],
  ["tengo ramas de la poda en la vereda", "retiro_no_habitual"],
  ["el camión no pasó", "reclamo_recoleccion"],
  ["quiero hacer un reclamo", "reclamo_recoleccion"],
  ["hace tres días que no pasan a levantar la basura", "reclamo_recoleccion"],
  ["quiero un taller para mi escuela", "programa_educa"],
  ["queremos pintar un mural en la plaza", "programa_transforma"],
  ["quiero entregar reciclables", "programa_separa"],

  // Cortesía
  ["hola", "saludo"],
  ["gracias", "despedida"],
];

const umbral = Number(catalogo.configuracion.get("umbral_confianza_router") ?? 0.6);

console.log(`Midiendo ${CASOS.length} frases con el modelo real. Umbral: ${umbral}\n`);

let bien = 0;
const fallas = [];
let costo = 0;

for (const [frase, esperada] of CASOS) {
  let r;
  try {
    r = await clasificar(frase, catalogo);
  } catch (e) {
    console.log(`  ERROR  ${JSON.stringify(frase)}: ${e.message}`);
    continue;
  }
  costo += r.costoUsd ?? 0;

  const d = decidir(r, catalogo);
  const ok = r.intencion === esperada;
  if (ok) bien++;
  else fallas.push({ frase, esperada, dio: r.intencion, conf: r.confianza, accion: d.tipo });

  console.log(
    `  ${ok ? "ok  " : "MAL "} ${JSON.stringify(frase).slice(0, 52).padEnd(54)} ` +
      `${r.intencion.padEnd(19)} ${String(r.confianza).padEnd(5)} -> ${d.tipo}`,
  );
}

console.log();
console.log(`  ${bien} de ${CASOS.length} correctas`);
console.log(`  costo de la medición: US$ ${costo.toFixed(6)}`);

if (fallas.length > 0) {
  console.log();
  console.log("  LAS QUE FALLARON:");
  for (const f of fallas) {
    console.log(
      `    ${JSON.stringify(f.frase)}\n` +
        `      esperaba ${f.esperada}, dio ${f.dio} (conf ${f.conf}) -> ${f.accion}`,
    );
  }
}

/* --- Lo que más importa: la consistencia --------------------------------- */
//
// La misma intención escrita de tres formas tiene que dar la misma etiqueta. Es
// lo que fallaba, y es lo que un promedio de aciertos puede esconder.

console.log();
console.log("  CONSISTENCIA — la misma intención, distintas formas:");

const GRUPOS = [
  [
    "una habilitación comercial",
    [
      "Necesito una habilitación comercial para abrir mi negocio",
      "Necesito una habilitación comercial",
      "habilitacion comercial",
      "como hago para habilitar un local",
    ],
  ],
  [
    "un retiro de escombros",
    [
      "necesito que retiren unos escombros de mi casa",
      "quiero pedir un retiro",
      "tengo escombros",
    ],
  ],
];

let inconsistentes = 0;
for (const [tema, frases] of GRUPOS) {
  const vistas = [];
  for (const f of frases) {
    try {
      const r = await clasificar(f, catalogo);
      costo += r.costoUsd ?? 0;
      vistas.push({ f, i: r.intencion, c: r.confianza });
    } catch {
      /* ignora */
    }
  }
  const distintas = new Set(vistas.map((v) => v.i));
  const consistente = distintas.size === 1;
  if (!consistente) inconsistentes++;
  console.log(`    ${consistente ? "ok  " : "MAL "} ${tema}: ${[...distintas].join(" / ")}`);
  if (!consistente) {
    for (const v of vistas) {
      console.log(`           ${v.i.padEnd(19)} ${String(v.c).padEnd(5)} ${JSON.stringify(v.f)}`);
    }
  }
}

console.log();
console.log(`  costo total: US$ ${costo.toFixed(6)}`);
console.log();
console.log(
  fallas.length === 0 && inconsistentes === 0
    ? "TODO OK"
    : `${fallas.length} falla(s), ${inconsistentes} grupo(s) inconsistente(s)`,
);
process.exit(fallas.length === 0 && inconsistentes === 0 ? 0 : 1);
