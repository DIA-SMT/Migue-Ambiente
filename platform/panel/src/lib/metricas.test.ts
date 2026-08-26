/**
 * Las cuentas que alimentan la portada.
 *
 * `metricas.ts` no tenía pruebas: 469 líneas de aritmética sobre las que se
 * apoya la única pantalla que dice si Migue sirve. Esto cubre lo que se agregó
 * para el tablero. Lo viejo sigue sin cubrir y conviene no olvidarlo.
 *
 * El caso que más importa acá es el del huso horario. La VPS corre en UTC y
 * Tucumán está tres horas atrás: un mensaje de las 22:30 del martes se guarda
 * con fecha del miércoles. Una serie diaria agrupada por el día UTC corre todos
 * los picos de la noche al día siguiente, y nadie lo nota mirando el gráfico.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DIAS_PARA_COTIZACION_VIEJA,
  convertirAPesos,
  medirVotos,
  pesos,
  repartoPorIntencion,
  serieDiaria,
  type ConversacionMedida,
  type MensajeMedido,
  type VotosDeConversacion,
} from "./metricas.ts";

function msg(p: Partial<MensajeMedido>): MensajeMedido {
  return {
    direccion: "saliente",
    intencion: null,
    confianza: null,
    origen_respuesta: null,
    modelo: null,
    tokens_entrada: null,
    tokens_salida: null,
    costo_usd: null,
    latencia_ms: null,
    fragmentos_citados: null,
    conversacion_id: "c1",
    creado_en: "2026-08-26T12:00:00.000Z",
    ...p,
  };
}

function conv(p: Partial<ConversacionMedida>): ConversacionMedida {
  return {
    id: "c1",
    canal: "telegram",
    canal_usuario_id: "1",
    estado: "abierta",
    cantidad_mensajes: 0,
    iniciada_en: "2026-08-26T12:00:00.000Z",
    ultima_actividad_en: "2026-08-26T12:00:00.000Z",
    ...p,
  };
}

// Mediodía de Tucumán del 26. Con dias=3 la ventana es 24, 25 y 26.
const AHORA = Date.parse("2026-08-26T15:00:00.000Z");

describe("serieDiaria", () => {
  it("devuelve un casillero por día, en orden y con los vacíos en cero", () => {
    const s = serieDiaria([], [], 3, AHORA);
    assert.deepEqual(
      s.map((d) => d.fecha),
      ["2026-08-24", "2026-08-25", "2026-08-26"],
    );
    assert.deepEqual(
      s.map((d) => d.turnos),
      [0, 0, 0],
    );
  });

  it("agrupa por el día de Tucumán y no por el de UTC", () => {
    // 01:30 UTC del 26 son las 22:30 del 25 en Tucumán. Si esto cayera en el 26,
    // toda la actividad nocturna aparecería corrida un día.
    const s = serieDiaria(
      [msg({ direccion: "entrante", creado_en: "2026-08-26T01:30:00.000Z" })],
      [],
      3,
      AHORA,
    );
    assert.equal(s.find((d) => d.fecha === "2026-08-25")?.turnos, 1);
    assert.equal(s.find((d) => d.fecha === "2026-08-26")?.turnos, 0);
  });

  it("cuenta como turno sólo lo que escribió el vecino", () => {
    const s = serieDiaria(
      [
        msg({ direccion: "entrante", creado_en: "2026-08-26T15:00:00.000Z" }),
        msg({ direccion: "saliente", creado_en: "2026-08-26T15:00:00.000Z" }),
        msg({ direccion: "saliente", creado_en: "2026-08-26T15:00:00.000Z" }),
      ],
      [],
      3,
      AHORA,
    );
    assert.equal(s.at(-1)?.turnos, 1);
  });

  it("suma el costo de los salientes, que es donde vive la traza", () => {
    const s = serieDiaria(
      [
        msg({ creado_en: "2026-08-26T15:00:00.000Z", costo_usd: 0.002 }),
        msg({ creado_en: "2026-08-26T15:00:00.000Z", costo_usd: 0.003 }),
        msg({ creado_en: "2026-08-26T15:00:00.000Z", costo_usd: null }),
      ],
      [],
      3,
      AHORA,
    );
    assert.equal(Math.round((s.at(-1)?.costoUsd ?? 0) * 1000), 5);
  });

  it("ignora lo que cae fuera de la ventana en vez de amontonarlo en el borde", () => {
    const s = serieDiaria(
      [msg({ direccion: "entrante", creado_en: "2026-07-01T15:00:00.000Z" })],
      [],
      3,
      AHORA,
    );
    assert.deepEqual(
      s.map((d) => d.turnos),
      [0, 0, 0],
    );
  });

  it("cuenta la conversación el día en que empezó", () => {
    const s = serieDiaria([], [conv({ iniciada_en: "2026-08-25T18:00:00.000Z" })], 3, AHORA);
    assert.equal(s.find((d) => d.fecha === "2026-08-25")?.conversaciones, 1);
  });
});

describe("repartoPorIntencion", () => {
  it("cuenta sobre los salientes: los entrantes tienen la intención en null", () => {
    const r = repartoPorIntencion([
      msg({ direccion: "saliente", intencion: "saludo" }),
      msg({ direccion: "entrante", intencion: "saludo" }),
      msg({ direccion: "saliente", intencion: null }),
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0]?.n, 1);
  });

  it("ordena de mayor a menor y traduce la clave", () => {
    const r = repartoPorIntencion([
      msg({ intencion: "saludo" }),
      msg({ intencion: "retiro_no_habitual" }),
      msg({ intencion: "retiro_no_habitual" }),
    ]);
    assert.equal(r[0]?.clave, "retiro_no_habitual");
    assert.equal(r[0]?.rotulo, "Retiro de residuos no habituales");
    assert.equal(r[0]?.n, 2);
  });

  it("separa los temas de la mecánica de la conversación", () => {
    const r = repartoPorIntencion([
      msg({ intencion: "reclamo_recoleccion" }),
      msg({ intencion: "despedida" }),
    ]);
    assert.equal(r.find((x) => x.clave === "reclamo_recoleccion")?.tema, true);
    assert.equal(r.find((x) => x.clave === "despedida")?.tema, false);
  });

  it("una intención que el panel no conoce se muestra igual, cruda", () => {
    // Si alguien agrega una intención en el bot, la portada la tiene que mostrar
    // sin que nadie toque el panel. Perderla en silencio es peor que verla fea.
    const r = repartoPorIntencion([msg({ intencion: "compostaje_domiciliario" })]);
    assert.equal(r[0]?.rotulo, "compostaje_domiciliario");
    assert.equal(r[0]?.n, 1);
  });

  it("marca «no entendió» como alerta y no como tema", () => {
    const r = repartoPorIntencion([msg({ intencion: "no_entendido" })]);
    assert.equal(r[0]?.tono, "alerta");
    assert.equal(r[0]?.tema, false);
  });
});

describe("medirVotos", () => {
  function voto(p: Partial<VotosDeConversacion>): VotosDeConversacion {
    return {
      votos_utiles: 0,
      votos_no_utiles: 0,
      votos_respuesta_mala: 0,
      votos_tramite_dificil: 0,
      ...p,
    };
  }

  it("suma los pulgares de todas las conversaciones", () => {
    const v = medirVotos([
      voto({ votos_utiles: 2, votos_no_utiles: 1 }),
      voto({ votos_utiles: 3 }),
    ]);
    assert.equal(v.utiles, 5);
    assert.equal(v.noUtiles, 1);
    assert.equal(v.total, 6);
  });

  it("no deduce los no útiles sumando respuesta mala y trámite difícil", () => {
    // Un voto anterior a la separación de las dos encuestas puede no estar en
    // ninguna de las dos columnas. Deducir el total sumándolas lo perdería.
    const v = medirVotos([
      voto({ votos_no_utiles: 3, votos_respuesta_mala: 1, votos_tramite_dificil: 1 }),
    ]);
    assert.equal(v.noUtiles, 3);
    assert.equal(v.respuestaMala, 1);
    assert.equal(v.tramiteDificil, 1);
  });

  it("sin conversaciones da todo en cero y no NaN", () => {
    const v = medirVotos([]);
    assert.deepEqual(v, {
      utiles: 0,
      noUtiles: 0,
      respuestaMala: 0,
      tramiteDificil: 0,
      total: 0,
    });
  });
});

describe("convertirAPesos", () => {
  const AYER = new Date(AHORA - 86_400_000).toISOString();

  it("sin cotización cargada no inventa un número", () => {
    const c = convertirAPesos(10, { valor: 0, actualizadoEn: AYER, editadaPorAlguien: true }, AHORA);
    assert.equal(c.hay, false);
    assert.equal(c.ars, 0);
  });

  it("convierte y dice hace cuántos días es la cotización", () => {
    const c = convertirAPesos(
      2,
      { valor: 1300, actualizadoEn: AYER, editadaPorAlguien: true },
      AHORA,
    );
    assert.equal(c.hay, true);
    assert.equal(c.ars, 2600);
    assert.equal(c.dias, 1);
    assert.equal(c.vieja, false);
  });

  it("pasado el umbral la marca vieja", () => {
    const viejo = new Date(AHORA - DIAS_PARA_COTIZACION_VIEJA * 86_400_000).toISOString();
    const c = convertirAPesos(1, { valor: 1300, actualizadoEn: viejo, editadaPorAlguien: true }, AHORA);
    assert.equal(c.vieja, true);
    assert.equal(c.dias, DIAS_PARA_COTIZACION_VIEJA);
  });

  it("una fila sembrada que nadie editó cuenta como vieja aunque la fecha sea de hoy", () => {
    // La migración deja `actualizado_en` con la fecha de la migración y
    // `actualizado_por` en null. Sin esta regla, una fila recién sembrada se
    // vería «actualizada hoy» sin que nadie haya mirado un número.
    const c = convertirAPesos(
      1,
      { valor: 1300, actualizadoEn: new Date(AHORA).toISOString(), editadaPorAlguien: false },
      AHORA,
    );
    assert.equal(c.hay, true);
    assert.equal(c.vieja, true);
    assert.equal(c.dias, 0);
  });

  it("una cotización negativa o absurda se trata como sin cargar", () => {
    for (const valor of [-1300, Number.NaN]) {
      const c = convertirAPesos(1, { valor, actualizadoEn: AYER, editadaPorAlguien: true }, AHORA);
      assert.equal(c.hay, false, `valor ${valor}`);
    }
  });
});

describe("pesos", () => {
  it("agrupa los miles con punto, como se escribe acá", () => {
    assert.equal(pesos(1234567), "$ 1.234.567");
  });

  it("muestra centavos sólo por debajo de cien", () => {
    assert.equal(pesos(14.5), "$ 14,50");
    assert.equal(pesos(1450), "$ 1.450");
  });

  it("con decimales forzados muestra la cotización tal cual, para poder rehacer la cuenta", () => {
    assert.equal(pesos(1385.5, 2), "$ 1.385,50");
    assert.equal(pesos(1385.5), "$ 1.386");
  });

  it("no usa el formateo de moneda de ICU, que puede diferir entre Node y el navegador", () => {
    // El símbolo, su posición y el tipo de espacio los pone este código, no ICU.
    // Un espacio duro acá contra uno normal allá es un error de hidratación.
    assert.equal(pesos(0), "$ 0,00");
    assert.ok(pesos(5000).startsWith("$ "));
    assert.ok(!pesos(5000).includes(" "));
  });
});
