import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_SLA_POR_DEFECTO,
  calcularVencimiento,
  describirPlazo,
  esDiaHabil,
  formatearFechaLocal,
  type ConfigSla,
} from "./sla.ts";

/** Jueves 12/02/2026, 12:00 hora de Tucumán (15:00 UTC). */
const JUEVES = new Date("2026-02-12T15:00:00.000Z");

const dias = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
function diaLocalDe(fecha: Date): string {
  return dias[new Date(fecha.getTime() - 3 * 3_600_000).getUTCDay()]!;
}

describe("esDiaHabil", () => {
  it("el domingo nunca es hábil", () => {
    assert.equal(esDiaHabil(new Date("2026-02-15T15:00:00Z"), CONFIG_SLA_POR_DEFECTO), false);
  });

  it("el sábado es hábil por defecto, porque la recolección trabaja sábados", () => {
    assert.equal(esDiaHabil(new Date("2026-02-14T15:00:00Z"), CONFIG_SLA_POR_DEFECTO), true);
  });

  it("el sábado deja de ser hábil si se configura así", () => {
    const cfg: ConfigSla = { ...CONFIG_SLA_POR_DEFECTO, sabadoEsHabil: false };
    assert.equal(esDiaHabil(new Date("2026-02-14T15:00:00Z"), cfg), false);
  });

  it("respeta los feriados cargados", () => {
    const cfg: ConfigSla = { ...CONFIG_SLA_POR_DEFECTO, feriados: ["2026-02-16", "2026-02-17"] };
    assert.equal(esDiaHabil(new Date("2026-02-16T15:00:00Z"), cfg), false);
    assert.equal(esDiaHabil(new Date("2026-02-17T15:00:00Z"), cfg), false);
    assert.equal(esDiaHabil(new Date("2026-02-18T15:00:00Z"), cfg), true);
  });

  it("usa la hora LOCAL, no UTC, para decidir el día", () => {
    // Sábado 14/02 a las 22:00 de Tucumán son las 01:00 UTC del domingo 15.
    // Si el cálculo usara UTC lo tomaría como domingo (no hábil) y estaría mal.
    const sabadoNoche = new Date("2026-02-15T01:00:00.000Z");
    const cfg: ConfigSla = { ...CONFIG_SLA_POR_DEFECTO, sabadoEsHabil: true };
    assert.equal(esDiaHabil(sabadoNoche, cfg), true, "debe leerse como sábado local");
  });
});

describe("calcularVencimiento", () => {
  it("reproduce el cálculo del bot anterior en modo horas_corridas", () => {
    // Regresión documental: así se generaron los tickets heredados.
    const cfg: ConfigSla = { ...CONFIG_SLA_POR_DEFECTO, modo: "horas_corridas" };
    const venc = calcularVencimiento(JUEVES, cfg);
    assert.equal(venc.toISOString(), "2026-02-15T15:00:00.000Z");
    assert.equal(diaLocalDe(venc), "domingo");
  });

  it("el default NO cae en domingo (el bug que corregimos)", () => {
    const venc = calcularVencimiento(JUEVES, CONFIG_SLA_POR_DEFECTO);
    assert.notEqual(diaLocalDe(venc), "domingo");
    assert.equal(esDiaHabil(venc, CONFIG_SLA_POR_DEFECTO), true);
  });

  it("con 72 h en días hábiles y sábado hábil, jueves vence el lunes", () => {
    // jueves -> viernes (1), sábado (2), domingo se saltea, lunes (3)
    const venc = calcularVencimiento(JUEVES, CONFIG_SLA_POR_DEFECTO);
    assert.equal(diaLocalDe(venc), "lunes");
    assert.equal(formatearFechaLocal(venc), "16/02/2026");
  });

  it("si el sábado no es hábil, el mismo pedido vence el martes", () => {
    const cfg: ConfigSla = { ...CONFIG_SLA_POR_DEFECTO, sabadoEsHabil: false };
    const venc = calcularVencimiento(JUEVES, cfg);
    assert.equal(diaLocalDe(venc), "martes");
    assert.equal(formatearFechaLocal(venc), "17/02/2026");
  });

  it("los feriados corren el vencimiento", () => {
    const cfg: ConfigSla = {
      ...CONFIG_SLA_POR_DEFECTO,
      sabadoEsHabil: false,
      feriados: ["2026-02-16", "2026-02-17"], // carnaval
    };
    const venc = calcularVencimiento(JUEVES, cfg);
    assert.equal(diaLocalDe(venc), "jueves");
    assert.equal(formatearFechaLocal(venc), "19/02/2026");
  });

  it("en modo horas_habiles el plazo se estira mucho más", () => {
    const cfg: ConfigSla = { ...CONFIG_SLA_POR_DEFECTO, modo: "horas_habiles" };
    const venc = calcularVencimiento(JUEVES, cfg);
    // 72 h de jornada de 8 h son 9 días laborables: por eso esta lectura es
    // literalmente correcta pero operativamente inaceptable para basura.
    assert.ok(
      venc.getTime() - JUEVES.getTime() > 8 * 24 * 3_600_000,
      "debería pasar más de 8 días corridos",
    );
    assert.equal(esDiaHabil(venc, cfg), true);
  });

  it("el vencimiento siempre cae en día hábil en los modos hábiles", () => {
    // Barrido sobre una semana entera: ningún día de partida debe producir un
    // vencimiento inhábil.
    for (let d = 9; d <= 15; d++) {
      const partida = new Date(`2026-02-${String(d).padStart(2, "0")}T15:00:00Z`);
      for (const sabadoEsHabil of [true, false]) {
        const cfg: ConfigSla = { ...CONFIG_SLA_POR_DEFECTO, sabadoEsHabil };
        const venc = calcularVencimiento(partida, cfg);
        assert.equal(
          esDiaHabil(venc, cfg),
          true,
          `partiendo del ${formatearFechaLocal(partida)} (sábado hábil: ${sabadoEsHabil})`,
        );
      }
    }
  });

  it("no se cuelga si los feriados cubren un rango absurdo", () => {
    const todoFeriado = Array.from({ length: 500 }, (_, i) => {
      const f = new Date(Date.UTC(2026, 1, 12) + i * 86_400_000);
      return f.toISOString().slice(0, 10);
    });
    const cfg: ConfigSla = { ...CONFIG_SLA_POR_DEFECTO, feriados: todoFeriado };
    // La cota de seguridad tiene que devolver algo, no entrar en bucle infinito.
    const venc = calcularVencimiento(JUEVES, cfg);
    assert.ok(venc instanceof Date && Number.isFinite(venc.getTime()));
  });
});

describe("describirPlazo", () => {
  it("describe cada modo en el idioma del vecino", () => {
    assert.equal(describirPlazo(CONFIG_SLA_POR_DEFECTO), "3 días hábiles");
    assert.equal(
      describirPlazo({ ...CONFIG_SLA_POR_DEFECTO, modo: "horas_corridas" }),
      "72 horas",
    );
    assert.equal(
      describirPlazo({ ...CONFIG_SLA_POR_DEFECTO, modo: "horas_habiles" }),
      "72 horas hábiles",
    );
  });

  it("usa el singular cuando corresponde", () => {
    assert.equal(describirPlazo({ ...CONFIG_SLA_POR_DEFECTO, horas: 24 }), "1 día hábil");
  });
});
