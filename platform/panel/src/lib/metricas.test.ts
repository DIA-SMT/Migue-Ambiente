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
  medirVotos,
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
