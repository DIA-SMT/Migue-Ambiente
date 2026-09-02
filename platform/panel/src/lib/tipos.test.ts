import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIA_FOTO_LEGIBLE,
  datosFaltantes,
  esEstadoConocido,
  estadoDeLaPregunta,
  estadoVisible,
  MOTIVOS_SIN_RESPUESTA,
  riesgoDelDisparador,
  situacionSla,
  tamanoLegible,
  veredictoDeFoto,
  type Documento,
  type PreguntaSinResponder,
  type Ticket,
} from "./tipos.ts";

function doc(parcial: Partial<Documento> = {}): Documento {
  return {
    id: "d1",
    titulo: "Plan Rector",
    descripcion: null,
    nombre_archivo: "plan.pdf",
    formato: "pdf",
    ruta_storage: "abc-plan.pdf",
    bytes: 1024,
    hash_sha256: "abc",
    paginas: 24,
    estado: "listo",
    error_detalle: null,
    cantidad_fragmentos: 17,
    activo: true,
    subido_por: null,
    creado_en: "2026-08-01T10:00:00Z",
    actualizado_en: "2026-08-01T10:00:00Z",
    ...parcial,
  };
}

/** Momento fijo, para que el test no dependa del reloj de la máquina. */
const AHORA = new Date("2026-08-01T10:05:00Z").getTime();

describe("estadoVisible", () => {
  it("traduce el estado, no muestra el enum", () => {
    // «procesando» no le dice nada a nadie del área de Ambiente.
    assert.equal(estadoVisible(doc({ estado: "pendiente" }), AHORA).etiqueta, "en cola");
    assert.equal(
      estadoVisible(doc({ estado: "procesando" }), AHORA).etiqueta,
      "leyendo el archivo",
    );
  });

  it("en «listo» la etiqueta es el conteo de fragmentos", () => {
    // Es el dato que importa: es lo que Migue puede citar.
    assert.equal(estadoVisible(doc({ cantidad_fragmentos: 33 }), AHORA).etiqueta, "33 fragmentos");
  });

  it("concuerda el singular", () => {
    // Se ve poco pero se ve, y en este corpus hay un documento con un solo
    // fragmento: decía «1 fragmentos».
    assert.equal(estadoVisible(doc({ cantidad_fragmentos: 1 }), AHORA).etiqueta, "1 fragmento");
    assert.equal(estadoVisible(doc({ cantidad_fragmentos: 2 }), AHORA).etiqueta, "2 fragmentos");
  });

  it("«listo» con CERO fragmentos no está listo", () => {
    // El caso del PDF escaneado. Mostrarlo en verde sería mentir.
    const e = estadoVisible(doc({ estado: "listo", cantidad_fragmentos: 0 }), AHORA);
    assert.equal(e.tono, "alerta");
    assert.equal(e.reintentable, true);
  });

  it("detecta el «procesando» eterno", () => {
    // `recuperar_trabajos_colgados` devuelve el trabajo a la cola pasados 15
    // minutos pero NO toca documentos.estado. Sin esto el panel muestra un
    // spinner que nunca termina.
    const viejo = doc({ estado: "procesando", actualizado_en: "2026-08-01T09:00:00Z" });
    const e = estadoVisible(viejo, AHORA);
    assert.equal(e.etiqueta, "parece colgado");
    assert.equal(e.reintentable, true);
    assert.match(e.detalle ?? "", /65 minutos/);
  });

  it("no lo marca colgado si recién arrancó", () => {
    const reciente = doc({ estado: "procesando", actualizado_en: "2026-08-01T10:04:00Z" });
    assert.equal(estadoVisible(reciente, AHORA).etiqueta, "leyendo el archivo");
  });

  it("un error muestra el detalle que escribió el worker", () => {
    const e = estadoVisible(
      doc({ estado: "error", error_detalle: "hay que pasarlo por un OCR" }),
      AHORA,
    );
    assert.equal(e.tono, "alerta");
    assert.equal(e.detalle, "hay que pasarlo por un OCR");
    assert.equal(e.reintentable, true);
  });
});

describe("tamanoLegible", () => {
  it("cubre el rango real del corpus, de 8 KB a 8 MB", () => {
    assert.equal(tamanoLegible(512), "512 B");
    assert.equal(tamanoLegible(8 * 1024), "8 KB");
    assert.equal(tamanoLegible(7922 * 1024), "7.7 MB");
  });
});

describe("riesgoDelDisparador", () => {
  it("un disparador que atrapa todo es una alerta", () => {
    // El caso peligroso: un regex «.*» publicado deja al bot respondiendo lo
    // mismo a cualquier cosa que escriba cualquier vecino.
    const r = riesgoDelDisparador({
      coincide_el_texto: true,
      mensajes_mirados: 200,
      mensajes_atrapados: 200,
      ejemplos: [],
    });
    assert.equal(r.tono, "alerta");
    assert.match(r.mensaje, /demasiado/);
  });

  it("un tercio ya es demasiado", () => {
    // Más de un tercio deja de ser una respuesta a una pregunta puntual y pasa
    // a ser el comportamiento por defecto del bot.
    assert.equal(
      riesgoDelDisparador({ coincide_el_texto: true, mensajes_mirados: 90, mensajes_atrapados: 31, ejemplos: [] }).tono,
      "alerta",
    );
    assert.equal(
      riesgoDelDisparador({ coincide_el_texto: true, mensajes_mirados: 90, mensajes_atrapados: 29, ejemplos: [] }).tono,
      "ok",
    );
  });

  it("cero coincidencias avisa pero no alarma", () => {
    // Puede estar bien —algo que nadie preguntó todavía— pero conviene revisar
    // que la palabra sea la que usa la gente.
    const r = riesgoDelDisparador({
      coincide_el_texto: false,
      mensajes_mirados: 50,
      mensajes_atrapados: 0,
      ejemplos: [],
    });
    assert.equal(r.tono, "curso");
  });

  it("sin mensajes con los que comparar, lo dice", () => {
    // No inventa una conclusión: es el estado del proyecto hoy, con 2 mensajes.
    const r = riesgoDelDisparador({
      coincide_el_texto: false,
      mensajes_mirados: 0,
      mensajes_atrapados: 0,
      ejemplos: [],
    });
    assert.equal(r.tono, "curso");
    assert.match(r.mensaje, /Todavía no hay mensajes/);
  });
});

describe("situacionSla", () => {
  function tk(parcial: Partial<Ticket> = {}): Ticket {
    return {
      id: "t1",
      ticket_type: "Pedido No Habitual",
      status: "En Proceso",
      address: "Lamadrid 50",
      user_name: null,
      chat_id: null,
      channel: "telegram",
      waste_type: "escombros",
      quantity: "3 bolsas",
      quantity_value: 3,
      quantity_unit: "bolsas",
      exceeds_limit: false,
      partial_pickup: false,
      days_without_service: null,
      derived_to: null,
      photo_ref: "f1",
      photo_url: null,
      photo_verdict: null,
      photo_category: null,
      photo_detail: null,
      notes: null,
      sla_deadline: "2026-08-28T19:00:00Z",
      resolved_at: null,
      created_at: "2026-08-25T12:00:00Z",
      updated_at: "2026-08-25T12:00:00Z",
      conversation_id: null,
      ...parcial,
    };
  }
  const AHORA = new Date("2026-08-26T12:00:00Z").getTime();

  it("un plazo vencido es lo más urgente", () => {
    // El plazo no es una meta interna: el bot le prometió una fecha concreta al
    // vecino. Vencerlo es una promesa incumplida.
    const s = situacionSla(tk({ sla_deadline: "2026-08-24T12:00:00Z" }), AHORA);
    assert.equal(s.tono, "alerta");
    assert.equal(s.urgencia, 0);
    assert.match(s.etiqueta, /vencido hace 2 d/);
  });

  it("avisa cuando falta menos de un día", () => {
    const s = situacionSla(tk({ sla_deadline: "2026-08-26T20:00:00Z" }), AHORA);
    assert.equal(s.tono, "curso");
    assert.match(s.etiqueta, /vence en 8 h/);
  });

  it("un resuelto no urge, aunque su plazo haya pasado", () => {
    const s = situacionSla(
      tk({ sla_deadline: "2026-08-01T12:00:00Z", resolved_at: "2026-08-02T12:00:00Z" }),
      AHORA,
    );
    assert.equal(s.etiqueta, "resuelto");
    assert.equal(s.urgencia, 4);
  });

  it("sin plazo cargado NO se inventa uno", () => {
    // Los tickets del bot anterior no lo tienen. Calcularlo hacia atrás sería
    // mostrar una fecha que nadie le prometió a nadie.
    const s = situacionSla(tk({ sla_deadline: null }), AHORA);
    assert.equal(s.etiqueta, "sin plazo");
    assert.equal(s.tono, "pend");
  });

  it("ordena lo vencido antes que lo que vence hoy", () => {
    const vencido = situacionSla(tk({ sla_deadline: "2026-08-20T12:00:00Z" }), AHORA);
    const hoy = situacionSla(tk({ sla_deadline: "2026-08-26T18:00:00Z" }), AHORA);
    const lejos = situacionSla(tk({ sla_deadline: "2026-09-10T12:00:00Z" }), AHORA);
    assert.ok(vencido.urgencia < hoy.urgencia);
    assert.ok(hoy.urgencia < lejos.urgencia);
  });
});

describe("datosFaltantes", () => {
  function tk(parcial: Partial<Ticket>): Ticket {
    return {
      id: "t",
      ticket_type: "Pedido No Habitual",
      status: "En Proceso",
      address: null,
      user_name: null,
      chat_id: null,
      channel: null,
      waste_type: null,
      quantity: null,
      quantity_value: null,
      quantity_unit: null,
      exceeds_limit: null,
      partial_pickup: null,
      days_without_service: null,
      derived_to: null,
      photo_ref: null,
      photo_url: null,
      photo_verdict: null,
      photo_category: null,
      photo_detail: null,
      notes: null,
      sla_deadline: null,
      resolved_at: null,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      conversation_id: null,
      ...parcial,
    };
  }

  it("marca lo que falta en un pedido incompleto", () => {
    // Es el caso de los 17 tickets del bot anterior: sin tipo de residuo ni
    // cantidad. Un caso a medias no se puede resolver, y quien lo abre tiene que
    // ver qué falta antes de intentarlo.
    assert.deepEqual(datosFaltantes(tk({})), [
      "dirección",
      "tipo de residuo",
      "cantidad",
      "foto",
    ]);
  });

  it("un pedido completo no falta nada", () => {
    assert.deepEqual(
      datosFaltantes(
        tk({ address: "Lamadrid 50", waste_type: "poda", quantity_value: 2, photo_ref: "f" }),
      ),
      [],
    );
  });

  it("a un reclamo no se le pide tipo ni foto", () => {
    // El flujo de reclamo no los captura: exigirlos marcaría como incompleto
    // todo reclamo bien tomado.
    assert.deepEqual(
      datosFaltantes(tk({ ticket_type: "Falta de Recolección", address: "Munecas 200" })),
      [],
    );
  });

  it("esEstadoConocido distingue lo que el panel ofrece de lo que no", () => {
    // El panel los muestra pero no los ofrece: son los que hay que normalizar.
    assert.equal(esEstadoConocido("Pendiente Validación Imagen"), false);
    assert.equal(esEstadoConocido("Pendiente Verificación GPS"), false);
    assert.equal(esEstadoConocido("En Proceso"), true);
    assert.equal(esEstadoConocido("Resuelto"), true);
  });
});

describe("un ticket cerrado por el bot anterior", () => {
  it("no figura como vencido si su ESTADO dice que se resolvió", () => {
    // El bot anterior seteaba `status` y no `resolved_at`. Mirando sólo la fecha,
    // un ticket «Resuelto» de febrero aparecía en la bandeja como vencido hace
    // medio año, y el área tendría que revisar de nuevo algo ya cerrado.
    const t = {
      id: "viejo", ticket_type: "Pedido No Habitual", status: "Resuelto",
      address: "Lamadrid 50", user_name: null, chat_id: null, channel: null,
      waste_type: null, quantity: null, quantity_value: null, quantity_unit: null,
      exceeds_limit: null, partial_pickup: null, days_without_service: null,
      derived_to: null, photo_ref: null, photo_url: null,
      photo_verdict: null, photo_category: null, photo_detail: null, notes: null,
      sla_deadline: "2026-02-20T12:00:00Z",
      resolved_at: null,
      created_at: "2026-02-17T12:00:00Z", updated_at: "2026-02-17T12:00:00Z",
      conversation_id: null,
    } satisfies Ticket;

    const s = situacionSla(t, new Date("2026-08-26T12:00:00Z").getTime());
    assert.equal(s.etiqueta, "resuelto");
    assert.equal(s.urgencia, 4);
  });

  it("pero uno que sigue pendiente SÍ figura vencido", () => {
    const t = {
      id: "abierto", ticket_type: "Pedido No Habitual", status: "Pendiente Validación Imagen",
      address: null, user_name: null, chat_id: null, channel: null,
      waste_type: null, quantity: null, quantity_value: null, quantity_unit: null,
      exceeds_limit: null, partial_pickup: null, days_without_service: null,
      derived_to: null, photo_ref: null, photo_url: null,
      photo_verdict: null, photo_category: null, photo_detail: null, notes: null,
      sla_deadline: "2026-02-20T12:00:00Z", resolved_at: null,
      created_at: "2026-02-17T12:00:00Z", updated_at: "2026-02-17T12:00:00Z",
      conversation_id: null,
    } satisfies Ticket;

    const s = situacionSla(t, new Date("2026-08-26T12:00:00Z").getTime());
    assert.equal(s.tono, "alerta");
    assert.equal(s.urgencia, 0);
  });
});

function pregunta(parcial: Partial<PreguntaSinResponder> = {}): PreguntaSinResponder {
  return {
    id: "p1",
    pregunta: "donde tiro el aceite usado de cocina",
    motivo: "sin_coincidencia",
    confianza: null,
    veces_repetida: 1,
    estado: "pendiente",
    notas: null,
    creado_en: "2026-08-20T10:00:00Z",
    actualizado_en: "2026-08-20T10:00:00Z",
    resuelta_con_faq_id: null,
    resuelta_con_fija_id: null,
    respuesta_titulo: null,
    respuesta_publicada: null,
    respuesta_tipo: null,
    ...parcial,
  };
}

describe("estadoDeLaPregunta", () => {
  it("una pregunta nueva está pendiente", () => {
    assert.equal(estadoDeLaPregunta(pregunta()).etiqueta, "pendiente");
  });

  it("una resuelta con la respuesta publicada dice «respondida»", () => {
    const e = estadoDeLaPregunta(
      pregunta({
        estado: "resuelta",
        resuelta_con_faq_id: "f1",
        respuesta_tipo: "faq",
        respuesta_publicada: true,
        respuesta_titulo: "¿Dónde llevo el aceite?",
      }),
    );
    assert.equal(e.etiqueta, "respondida");
    assert.equal(e.tono, "ok");
    assert.equal(e.detalle, "¿Dónde llevo el aceite?");
  });

  // ESTE es el caso que justifica que la función exista. Alguien escribió la
  // respuesta, la pregunta figura «resuelta», y el vecino que vuelva a
  // preguntar lo mismo va a fallar IGUAL porque el borrador no está publicado.
  // Si esto se mostrara como respondida, el panel diría que el trabajo está
  // hecho cuando falta el único paso que lo hace servir.
  it("una resuelta con el borrador sin publicar NO dice respondida", () => {
    const e = estadoDeLaPregunta(
      pregunta({
        estado: "resuelta",
        resuelta_con_faq_id: "f1",
        respuesta_tipo: "faq",
        respuesta_publicada: false,
        respuesta_titulo: "¿Dónde llevo el aceite?",
      }),
    );
    assert.equal(e.etiqueta, "falta publicar");
    assert.equal(e.tono, "alerta");
    assert.match(e.detalle ?? "", /todavía no lo usa/);
    // Y el tono tiene que ser de alerta, no el neutro de «pendiente»: es
    // trabajo hecho a medias, que es peor que trabajo sin empezar porque nadie
    // lo va a volver a tomar.
    assert.notEqual(e.tono, "ok");
  });

  it("distingue una respuesta textual de una frecuente", () => {
    const e = estadoDeLaPregunta(
      pregunta({
        estado: "resuelta",
        resuelta_con_fija_id: "r1",
        respuesta_tipo: "fija",
        respuesta_publicada: true,
        respuesta_titulo: "Derivar a Rentas",
      }),
    );
    assert.equal(e.etiqueta, "respondida");
    assert.equal(e.detalle, "Derivar a Rentas");
  });

  // Pasa si alguien la marca resuelta por fuera del panel, con service_role.
  // Queda visible en vez de darla por buena: no hay ninguna respuesta escrita.
  it("una resuelta sin nada vinculado se muestra como anomalía", () => {
    const e = estadoDeLaPregunta(pregunta({ estado: "resuelta" }));
    assert.equal(e.etiqueta, "resuelta sin respuesta vinculada");
    assert.notEqual(e.tono, "ok");
  });

  it("una descartada muestra el motivo que se anotó", () => {
    const e = estadoDeLaPregunta(
      pregunta({ estado: "descartada", notas: "Es una prueba nuestra" }),
    );
    assert.equal(e.etiqueta, "descartada");
    assert.equal(e.detalle, "Es una prueba nuestra");
  });
});

describe("MOTIVOS_SIN_RESPUESTA", () => {
  // El CHECK de `sin_respuesta.motivo` en la migración 004 admite exactamente
  // estos cuatro. Si la base agrega un quinto y esta tabla no lo tiene, el
  // panel busca `MOTIVOS_SIN_RESPUESTA[motivo]` y explota con «cannot read
  // properties of undefined» al renderizar la fila.
  const DEL_CHECK = ["sin_coincidencia", "confianza_baja", "fuera_de_alcance", "error_modelo"];

  it("cubre los cuatro motivos que admite el CHECK de la base", () => {
    assert.deepEqual(Object.keys(MOTIVOS_SIN_RESPUESTA).sort(), [...DEL_CHECK].sort());
  });

  it("cada motivo dice qué hacer, y sólo error_modelo no es accionable", () => {
    for (const [clave, m] of Object.entries(MOTIVOS_SIN_RESPUESTA)) {
      assert.ok(m.etiqueta.length > 0, `${clave} sin etiqueta`);
      assert.ok(m.queHacer.length > 0, `${clave} no dice qué hacer`);
    }
    // Escribir una respuesta no arregla que se haya caído el proveedor del
    // modelo, así que la pantalla no ofrece esa acción para ese motivo.
    assert.equal(MOTIVOS_SIN_RESPUESTA.error_modelo.accionable, false);
    assert.equal(MOTIVOS_SIN_RESPUESTA.sin_coincidencia.accionable, true);
    assert.equal(MOTIVOS_SIN_RESPUESTA.confianza_baja.accionable, true);
  });

  it("los tonos son clases de chip que el CSS define", () => {
    // Un tono inventado sale sin estilo: el chip queda transparente y no se lee.
    const TONOS = ["ok", "curso", "pend", "alerta"];
    for (const [clave, m] of Object.entries(MOTIVOS_SIN_RESPUESTA)) {
      assert.ok(TONOS.includes(m.tono), `${clave} usa el tono «${m.tono}», que no existe`);
    }
  });
});

describe("veredictoDeFoto", () => {
  const TONOS = ["ok", "curso", "pend", "alerta"];

  it("cubre los cuatro veredictos del CHECK de la base, y null para sin foto", () => {
    for (const v of ["valida", "dudosa", "no_corresponde", "no_evaluada"] as const) {
      const chip = veredictoDeFoto({ photo_verdict: v });
      assert.ok(chip, `«${v}» tendría que dar chip`);
      assert.ok(TONOS.includes(chip.tono), `«${v}» usa el tono «${chip.tono}», que no existe`);
    }
    assert.equal(veredictoDeFoto({ photo_verdict: null }), null);
  });

  it("los problemáticos llaman la atención y el resto no", () => {
    assert.equal(veredictoDeFoto({ photo_verdict: "no_corresponde" })!.tono, "alerta");
    assert.equal(veredictoDeFoto({ photo_verdict: "dudosa" })!.tono, "curso");
    assert.equal(veredictoDeFoto({ photo_verdict: "valida" })!.tono, "ok");
  });

  it("toda categoría del CHECK tiene traducción legible", () => {
    for (const c of ["basural", "volcadero", "rnh", "barrido", "limpieza_cestos", "otros"]) {
      assert.ok(CATEGORIA_FOTO_LEGIBLE[c], `falta la traducción de «${c}»`);
    }
  });
});
