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
  medirCanales,
  medirEntrantes,
  convertirAPesos,
  haceCuanto,
  medirGasto,
  medirPunteria,
  ultimaActividad,
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
    texto: "hola",
    media_tipo: null,
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

describe("medirGasto", () => {
  it("corta el mes en hora de Tucumán y no en UTC", () => {
    // 01:30 UTC del 1 de septiembre son las 22:30 del 31 de AGOSTO en Tucumán.
    // Con el corte en UTC ese gasto se contaría en septiembre y el mes cerraría
    // con plata que no le corresponde.
    const g = medirGasto(
      [
        msg({ creado_en: "2026-09-01T01:30:00.000Z", costo_usd: 0.5 }),
        msg({ creado_en: "2026-08-26T15:00:00.000Z", costo_usd: 0.25 }),
      ],
      AHORA,
    );
    assert.equal(g.mesUsd, 0.75);
    assert.equal(g.etiquetaDelMes, "agosto de 2026");
  });

  it("el histórico incluye meses anteriores y el del mes no", () => {
    const g = medirGasto(
      [
        msg({ creado_en: "2026-08-26T15:00:00.000Z", costo_usd: 1 }),
        msg({ creado_en: "2026-05-10T15:00:00.000Z", costo_usd: 10 }),
      ],
      AHORA,
    );
    assert.equal(g.mesUsd, 1);
    assert.equal(g.historicoUsd, 11);
  });

  it("no cuenta lo que escribió el vecino: la traza vive en el saliente", () => {
    const g = medirGasto(
      [msg({ direccion: "entrante", creado_en: "2026-08-26T15:00:00.000Z", costo_usd: 9 })],
      AHORA,
    );
    assert.equal(g.mesUsd, 0);
    assert.equal(g.salientesDelMes, 0);
  });

  it("informa la cobertura del mes, porque el total es un piso", () => {
    const g = medirGasto(
      [
        msg({ creado_en: "2026-08-26T15:00:00.000Z", costo_usd: 1 }),
        msg({ creado_en: "2026-08-26T15:00:00.000Z", costo_usd: null }),
      ],
      AHORA,
    );
    assert.equal(g.salientesDelMes, 2);
    assert.equal(g.conDatoEnElMes, 1);
  });

  it("sin mensajes da cero y una etiqueta válida, no NaN", () => {
    const g = medirGasto([], AHORA);
    assert.equal(g.mesUsd, 0);
    assert.equal(g.historicoUsd, 0);
    assert.equal(g.etiquetaDelMes, "agosto de 2026");
  });
});

describe("medirPunteria", () => {
  it("un saludo NO cuenta como que Migue acertó", () => {
    // El caso que hace que este número no mienta. `origen_respuesta = 'flujo'`
    // se escribe en ocho lugares del orquestador y etiqueta cinco cosas: paso
    // de trámite, saludo, despedida, acuse de voto y arranque de flujo. Contar
    // las cinco como acierto convierte cada «hola» en un éxito.
    const p = medirPunteria([
      msg({ origen_respuesta: "flujo", intencion: "saludo" }),
      msg({ origen_respuesta: "flujo", intencion: "despedida" }),
      msg({ origen_respuesta: "flujo", intencion: "voto_util" }),
    ]);
    assert.equal(p.guio, 0);
    assert.equal(p.decisiones, 0, "la mecánica de la charla no es una decisión");
  });

  it("un paso de trámite SÍ cuenta: su intención es el nombre del flujo", () => {
    const p = medirPunteria([
      msg({ origen_respuesta: "flujo", intencion: "retiro_no_habitual" }),
      msg({ origen_respuesta: "flujo", intencion: "reclamo_recoleccion" }),
    ]);
    assert.equal(p.guio, 2);
    assert.equal(p.decisiones, 2);
  });

  it("separa encontrar material de guiar un trámite y de derivar", () => {
    const p = medirPunteria([
      msg({ origen_respuesta: "faq" }),
      msg({ origen_respuesta: "documentos" }),
      msg({ origen_respuesta: "respuesta_fija" }),
      msg({ origen_respuesta: "flujo", intencion: "programa_separa" }),
      msg({ origen_respuesta: "exclusion" }),
      msg({ origen_respuesta: "fallback" }),
    ]);
    assert.equal(p.encontro, 3);
    assert.equal(p.guio, 1);
    assert.equal(p.derivo, 1);
    assert.equal(p.cayoAlMenu, 1);
    assert.equal(p.decisiones, 6);
  });

  it("derivar a otra área es una respuesta correcta, no una falla", () => {
    // Mandar «hay olor a gas» al área que corresponde es lo que hay que hacer.
    const p = medirPunteria([msg({ origen_respuesta: "exclusion" })]);
    assert.equal(p.derivo, 1);
    assert.equal(p.cayoAlMenu, 0);
  });

  it("los mensajes de cortesía quedan fuera del denominador", () => {
    // El «¿te sirvió?» y el «gracias» se guardan con origen en null desde la
    // 022. Si entraran, el denominador sería «mensajes que mandó el bot» y no
    // «veces que tuvo que decidir algo».
    const p = medirPunteria([
      msg({ origen_respuesta: "faq" }),
      msg({ origen_respuesta: null }),
      msg({ origen_respuesta: null }),
    ]);
    assert.equal(p.decisiones, 1);
  });

  it("las partes suman el total, sin filtraciones", () => {
    const p = medirPunteria([
      msg({ origen_respuesta: "faq" }),
      msg({ origen_respuesta: "flujo", intencion: "retiro_no_habitual" }),
      msg({ origen_respuesta: "exclusion" }),
      msg({ origen_respuesta: "fallback" }),
      msg({ origen_respuesta: "flujo", intencion: "saludo" }),
    ]);
    assert.equal(p.encontro + p.guio + p.derivo + p.cayoAlMenu, p.decisiones);
  });

  it("un origen que el panel no conoce entra al denominador igual", () => {
    // Perderlo en silencio haría que los porcentajes cierren sobre un total
    // que no es el real.
    const p = medirPunteria([msg({ origen_respuesta: "algo_nuevo" as never })]);
    assert.equal(p.decisiones, 1);
  });

  it("ignora los entrantes", () => {
    const p = medirPunteria([msg({ direccion: "entrante", origen_respuesta: "faq" })]);
    assert.equal(p.decisiones, 0);
  });
});

describe("ultimaActividad y haceCuanto", () => {
  it("toma el mensaje más nuevo aunque la lista venga desordenada", () => {
    const a = ultimaActividad(
      [
        msg({ creado_en: "2026-08-20T10:00:00.000Z" }),
        msg({ creado_en: "2026-08-26T14:00:00.000Z" }),
        msg({ creado_en: "2026-08-01T10:00:00.000Z" }),
      ],
      AHORA,
    );
    assert.equal(a.haceMs, 3_600_000);
  });

  it("sin mensajes no inventa una fecha", () => {
    assert.deepEqual(ultimaActividad([], AHORA), { ultimoEn: null, haceMs: null });
  });

  it("nunca da un tiempo negativo si un mensaje viene del futuro", () => {
    // Pasa con relojes desincronizados. «hace -4 minutos» es peor que «recién».
    const a = ultimaActividad([msg({ creado_en: "2026-08-26T15:04:00.000Z" })], AHORA);
    assert.equal(a.haceMs, 0);
  });

  it("redacta el tiempo en singular y plural", () => {
    assert.equal(haceCuanto(null), "nunca");
    assert.equal(haceCuanto(30_000), "recién");
    assert.equal(haceCuanto(60_000), "hace 1 minuto");
    assert.equal(haceCuanto(120_000), "hace 2 minutos");
    assert.equal(haceCuanto(3_600_000), "hace 1 hora");
    assert.equal(haceCuanto(7_200_000), "hace 2 horas");
    assert.equal(haceCuanto(86_400_000), "hace 1 día");
    assert.equal(haceCuanto(5 * 86_400_000), "hace 5 días");
  });
});

describe("medirEntrantes", () => {
  it("un toque de botón no es un mensaje escrito", () => {
    // Es la distinción que hace honesto el número grande del tablero: elegir
    // una opción del menú o tocar un pulgar queda en la base como un entrante
    // igual que una frase. `normalizarSeleccion` manda texto null y no persiste
    // cuál fue la opción, así que sin texto y sin media sólo puede ser un toque.
    const e = medirEntrantes([
      msg({ direccion: "entrante", texto: "quiero que retiren escombros" }),
      msg({ direccion: "entrante", texto: null, media_tipo: null }),
      msg({ direccion: "entrante", texto: null, media_tipo: null }),
    ]);
    assert.equal(e.escritos, 1);
    assert.equal(e.toques, 2);
    assert.equal(e.total, 3);
  });

  it("cuenta los audios aparte, que Migue no transcribe", () => {
    const e = medirEntrantes([
      msg({ direccion: "entrante", texto: null, media_tipo: "audio" }),
      msg({ direccion: "entrante", texto: null, media_tipo: "imagen" }),
    ]);
    assert.equal(e.conMedia, 2);
    assert.equal(e.audios, 1);
    assert.equal(e.toques, 0, "una foto sin texto no es un toque de botón");
  });

  it("las partes suman el total", () => {
    const e = medirEntrantes([
      msg({ direccion: "entrante", texto: "hola" }),
      msg({ direccion: "entrante", texto: null, media_tipo: null }),
      msg({ direccion: "entrante", texto: null, media_tipo: "imagen" }),
      msg({ direccion: "saliente", texto: "respuesta" }),
    ]);
    assert.equal(e.escritos + e.toques + e.conMedia, e.total);
    assert.equal(e.total, 3, "los salientes no entran");
  });
});

describe("medirCanales", () => {
  it("no mezcla identidades entre canales", () => {
    // La misma persona en Telegram y en WhatsApp son dos identidades, y está
    // bien que lo sean: no hay forma de saber que son el mismo vecino.
    const c = medirCanales([
      conv({ id: "a", canal: "telegram", canal_usuario_id: "1" }),
      conv({ id: "b", canal: "telegram", canal_usuario_id: "1" }),
      conv({ id: "c", canal: "telegram", canal_usuario_id: "2" }),
      conv({ id: "d", canal: "whatsapp", canal_usuario_id: "1" }),
    ]);
    assert.equal(c.length, 2);
    const tg = c.find((x) => x.canal === "telegram");
    assert.equal(tg?.personas, 2);
    assert.equal(tg?.conversaciones, 3);
    assert.equal(c.find((x) => x.canal === "whatsapp")?.personas, 1);
  });

  it("ordena por volumen y sin conversaciones devuelve vacío", () => {
    assert.deepEqual(medirCanales([]), []);
    const c = medirCanales([
      conv({ id: "a", canal: "whatsapp", canal_usuario_id: "1" }),
      conv({ id: "b", canal: "telegram", canal_usuario_id: "1" }),
      conv({ id: "c", canal: "telegram", canal_usuario_id: "2" }),
    ]);
    assert.equal(c[0]?.canal, "telegram");
  });
});
