import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  datosFaltantes,
  esEstadoHeredado,
  estadoVisible,
  riesgoDelDisparador,
  situacionSla,
  tamanoLegible,
  type Documento,
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

  it("esEstadoHeredado distingue los estados del bot anterior", () => {
    // El panel los muestra pero no los ofrece: son los que hay que normalizar.
    assert.equal(esEstadoHeredado("Pendiente Validación Imagen"), true);
    assert.equal(esEstadoHeredado("Pendiente Verificación GPS"), true);
    assert.equal(esEstadoHeredado("En Proceso"), false);
    assert.equal(esEstadoHeredado("Resuelto"), false);
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
      derived_to: null, photo_ref: null, photo_url: null, notes: null,
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
      derived_to: null, photo_ref: null, photo_url: null, notes: null,
      sla_deadline: "2026-02-20T12:00:00Z", resolved_at: null,
      created_at: "2026-02-17T12:00:00Z", updated_at: "2026-02-17T12:00:00Z",
      conversation_id: null,
    } satisfies Ticket;

    const s = situacionSla(t, new Date("2026-08-26T12:00:00Z").getTime());
    assert.equal(s.tono, "alerta");
    assert.equal(s.urgencia, 0);
  });
});
