/**
 * Pruebas de integración contra la Supabase real. SÓLO LECTURA.
 *
 * Se saltean solas si no hay credenciales, así `pnpm test` sigue funcionando en
 * cualquier máquina. En la VPS corren con:
 *
 *   set -a; . /srv/bots/.secrets/migue.env; set +a; node --test
 *
 * Verifican algo que los tests unitarios no pueden: que el mapeo de columnas
 * coincida con el esquema que realmente está desplegado. Un `limite_valor` que
 * llega como string en vez de número no lo detecta ningún mock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  configSla,
  describirPuntosVerdes,
  invalidarCatalogo,
  leerConfig,
  leerTexto,
  obtenerCatalogo,
} from "./catalogo.ts";
import { verificarConexion } from "./cliente.ts";
import { evaluarExclusiones } from "../reglas/exclusiones.ts";
import { limiteDe, validarVolumen } from "../reglas/volumen.ts";
import { interpretarCantidad } from "../reglas/cantidad.ts";
import { calcularVencimiento, esDiaHabil } from "../reglas/sla.ts";

const hayCredenciales =
  Boolean(process.env["SUPABASE_URL"]) && Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]);

describe("catálogo contra Supabase real", { skip: !hayCredenciales ? "sin credenciales" : false }, () => {
  it("se conecta", async () => {
    assert.equal(await verificarConexion(), true);
  });

  it("trae las seis colecciones del catálogo", async () => {
    const c = await obtenerCatalogo();
    assert.ok(c.configuracion.size >= 10, `configuración: ${c.configuracion.size}`);
    assert.ok(c.textos.size >= 16, `textos: ${c.textos.size}`);
    assert.equal(c.reglasExclusion.length, 7);
    assert.equal(c.limitesVolumen.length, 3);
    assert.equal(c.puntosVerdes.length, 3, "si son 9, volvió el bug de duplicación");
    assert.equal(c.zonas.length, 2);
  });

  it("los límites llegan como NÚMEROS, no como strings", async () => {
    // Postgres devuelve `numeric` como string para no perder precisión. Sin el
    // Number() del mapeo, la comparación sería lexicográfica y "10" < "5".
    const c = await obtenerCatalogo();
    for (const l of c.limitesVolumen) {
      assert.equal(typeof l.limiteValor, "number", `${l.categoria}.limiteValor`);
      assert.ok(Number.isFinite(l.limiteValor));
    }
    const poda = limiteDe("poda", c.limitesVolumen)!;
    const escombros = limiteDe("escombros", c.limitesVolumen)!;
    assert.ok(poda.limiteValor > escombros.limiteValor, "10 debe ser mayor que 5");
  });

  it("los límites coinciden con el anexo de la spec", async () => {
    const c = await obtenerCatalogo();
    assert.equal(limiteDe("escombros", c.limitesVolumen)?.limiteValor, 5);
    assert.equal(limiteDe("escombros", c.limitesVolumen)?.pesoMaxBolsaKg, 15);
    assert.equal(limiteDe("poda", c.limitesVolumen)?.limiteValor, 10);
    assert.equal(limiteDe("voluminosos", c.limitesVolumen)?.limiteValor, 1);
    assert.equal(limiteDe("voluminosos", c.limitesVolumen)?.limiteUnidad, "m3");
  });

  it("las reglas de exclusión vienen ordenadas y gas va primero", async () => {
    const c = await obtenerCatalogo();
    assert.equal(c.reglasExclusion[0]?.nombre, "Fuga de gas");
    const prioridades = c.reglasExclusion.map((r) => r.prioridad);
    assert.deepEqual(prioridades, [...prioridades].sort((a, b) => a - b));
  });

  it("las reglas reales derivan lo que deben y NO lo que no deben", async () => {
    const c = await obtenerCatalogo();

    const derivan: Array<[string, string]> = [
      ["siento olor a gas en la cocina", "Fuga de gas"],
      ["hay una perdida de agua en la vereda", "Agua y cloacas (SAT)"],
      ["tengo 4 neumaticos viejos", "Neumaticos"],
      ["se cayo un arbol en la cuadra", "Arbol caido o rama de gran porte"],
    ];
    for (const [texto, esperada] of derivan) {
      const r = evaluarExclusiones(texto, c.reglasExclusion);
      assert.equal(r?.regla.nombre, esperada, `"${texto}"`);
    }

    // Los falsos positivos son el riesgo real: derivar a alguien que el bot
    // sí podía atender.
    for (const texto of [
      "necesito retirar 5 bolsas de escombros",
      "cuando pasa el camion por casa",
      "donde hay un punto verde",
      "quiero un taller del programa educa",
      "cuanto gasto si contrato un contenedor",
    ]) {
      const r = evaluarExclusiones(texto, c.reglasExclusion);
      assert.equal(r, null, `"${texto}" se derivó a ${r?.regla.nombre}`);
    }
  });

  it("los textos institucionales están cargados y no vacíos", async () => {
    const c = await obtenerCatalogo();
    for (const clave of [
      "bienvenida",
      "retiro_requisitos",
      "retiro_pedir_foto",
      "retiro_confirmacion",
      "reclamo_confirmacion",
      "separa_info",
      "sin_respuesta",
      "fuera_de_alcance",
    ]) {
      const texto = leerTexto(c, clave);
      assert.doesNotMatch(texto, /^\[falta texto/, `falta el texto "${clave}"`);
      assert.ok(texto.length > 15, `"${clave}" parece truncado: ${texto}`);
    }
  });

  it("la Regla de Oro sobrevivió al viaje por la base", async () => {
    // Los saltos de línea y el emoji del texto de la spec tienen que llegar
    // intactos: es la instrucción que evita que el vecino saque los residuos
    // antes de la confirmación y se coma una multa.
    const c = await obtenerCatalogo();
    const texto = leerTexto(c, "retiro_requisitos");
    assert.match(texto, /Regla de Oro/);
    assert.match(texto, /NO saques los residuos/);
    assert.ok(texto.includes("\n"), "los saltos de línea deben conservarse");
  });

  it("la configuración se lee con los tipos correctos", async () => {
    const c = await obtenerCatalogo();
    assert.equal(leerConfig(c, "sla_horas_habiles", 0), 72);
    assert.equal(leerConfig(c, "empresa_recoleccion", ""), "Transporte 9 de Julio");
    assert.equal(leerConfig(c, "foto_obligatoria_retiro", false), true);
    assert.equal(typeof leerConfig(c, "umbral_confianza", 0), "number");
    // Un valor inexistente cae al respaldo en vez de romper.
    assert.equal(leerConfig(c, "clave_que_no_existe", "respaldo"), "respaldo");
  });

  it("el plazo calculado con la config real no cae en día inhábil", async () => {
    const c = await obtenerCatalogo();
    const cfg = configSla(c);
    assert.equal(cfg.horas, 72);
    // El mismo jueves del ticket heredado que vencía en domingo.
    const venc = calcularVencimiento(new Date("2026-02-12T15:00:00Z"), cfg);
    assert.equal(esDiaHabil(venc, cfg), true, "el plazo real no puede caer en día inhábil");
  });

  it("cadena completa: texto del vecino -> decisión, con datos reales", async () => {
    const c = await obtenerCatalogo();
    const escombros = limiteDe("escombros", c.limitesVolumen)!;

    const dentro = validarVolumen(interpretarCantidad("tengo 3 bolsas de escombros"), escombros);
    assert.equal(dentro.tipo, "dentro");

    const excede = validarVolumen(interpretarCantidad("como 12 bolsas de escombros"), escombros);
    assert.equal(excede.tipo, "excede");
    if (excede.tipo === "excede") {
      assert.equal(excede.accion, "parcial_con_ticket");
      assert.ok(excede.texto.length > 20, "el texto de exceso viene de la base");
    }

    const precisar = validarVolumen(interpretarCantidad("un camion entero"), escombros);
    assert.equal(precisar.tipo, "precisar");
  });

  it("los Puntos Verdes se describen con dirección y horario", async () => {
    const c = await obtenerCatalogo();
    const texto = describirPuntosVerdes(c);
    assert.match(texto, /Lamadrid 3700/);
    assert.match(texto, /24 hs/);
    assert.equal(texto.split("\n").length, 3);
  });

  it("el caché evita repetir consultas", async () => {
    invalidarCatalogo();
    const primera = await obtenerCatalogo();
    const segunda = await obtenerCatalogo();
    // Misma referencia: la segunda no volvió a la base.
    assert.equal(primera, segunda);
  });
});

/**
 * Guarda contra la deriva entre el fixture de pruebas y la base real.
 *
 * Es el error que se cometió al escribir el flujo B: el fixture tenía un texto
 * de confirmación sin `{empresa}` mientras la migración 011 lo había agregado.
 * El test de flujo pasaba en verde y no describía lo que iba a recibir el
 * vecino. Un fixture que no espeja producción es peor que no tener fixture.
 */
describe("el fixture de pruebas espeja la base real", { skip: !hayCredenciales ? "sin credenciales" : false }, () => {
  it("los textos usados por los flujos tienen los MISMOS marcadores", async () => {
    const { catalogoPrueba } = await import("../flujos/_fixtures.ts");
    const real = await obtenerCatalogo();
    const fixture = catalogoPrueba();

    const marcadores = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

    for (const clave of ["retiro_confirmacion", "reclamo_confirmacion"]) {
      assert.deepEqual(
        marcadores(leerTexto(fixture, clave)),
        marcadores(leerTexto(real, clave)),
        `el fixture y la base difieren en los marcadores de "${clave}"`,
      );
    }
  });

  it("las categorías de límites del fixture existen en la base", async () => {
    const { LIMITES_PRUEBA } = await import("../flujos/_fixtures.ts");
    const real = await obtenerCatalogo();
    const categoriasReales = new Set(real.limitesVolumen.map((l) => l.categoria));
    for (const l of LIMITES_PRUEBA) {
      assert.ok(categoriasReales.has(l.categoria), `falta la categoría ${l.categoria} en la base`);
    }
  });

  it("los límites del fixture coinciden con los de la base", async () => {
    const { LIMITES_PRUEBA } = await import("../flujos/_fixtures.ts");
    const real = await obtenerCatalogo();
    for (const esperado of LIMITES_PRUEBA) {
      const actual = real.limitesVolumen.find((l) => l.categoria === esperado.categoria)!;
      assert.equal(actual.limiteValor, esperado.limiteValor, `límite de ${esperado.categoria}`);
      assert.equal(actual.limiteUnidad, esperado.limiteUnidad, `unidad de ${esperado.categoria}`);
    }
  });
})
