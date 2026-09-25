/**
 * Integración de ESCRITURA contra la Supabase real.
 *
 * A diferencia del resto de las pruebas de integración, esta escribe. Verifica
 * lo único que ningún test unitario puede: que el mapeo de columnas de
 * `crearTicket` —quince columnas, mezclando nombres en inglés heredados con
 * campos nuevos— coincida con el esquema desplegado. Los dos errores más caros
 * del proyecto hasta ahora fueron de ese tipo: una columna inexistente y un
 * `numeric` que llegaba como string.
 *
 * Todas las filas se crean con un marcador reconocible y se BORRAN en un
 * `finally`, incluso si el test falla. El borrado usa la clave de servicio, que
 * pasa por encima de RLS; desde el panel estas tablas no permiten `delete`.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { obtenerCliente } from "./cliente.ts";
import {
  obtenerOAbrirConversacion,
  registrarEntrante,
  registrarSaliente,
} from "./conversaciones.ts";
import { crearSolicitudPrograma, crearTicket, registrarSinRespuesta } from "./registros.ts";
import { aplicarEfectos, idDeTicket } from "./efectos.ts";
import { decir, type MensajeEntrante } from "../mensajeria.ts";
import type { DatosTicket } from "../flujos/tipos.ts";

const hayCredenciales =
  Boolean(process.env["SUPABASE_URL"]) && Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]);

/** Marcador para poder identificar y borrar todo lo que crea esta suite. */
const USUARIO_PRUEBA = "__prueba_escritura__";

const creados = { conversaciones: [] as string[], tickets: [] as string[], solicitudes: [] as string[], sinRespuesta: [] as string[] };

function entrantePrueba(texto: string): MensajeEntrante {
  return {
    canal: "telegram",
    canalUsuarioId: USUARIO_PRUEBA,
    nombreUsuario: "Prueba Automatizada",
    texto,
    media: null,
    seleccion: null,
    recibidoEn: new Date(),
  };
}

const TICKET_BASE: DatosTicket = {
  tipo: "Pedido No Habitual",
  direccion: "Calle De Prueba 123, entre A y B",
  tipoResiduo: "escombros",
  cantidadValor: 4,
  cantidadUnidad: "bolsas",
  excedeLimite: false,
  retiroParcial: false,
  fotoReferencia: "ref-de-prueba-abc",
  diasSinServicio: null,
  vencimiento: new Date("2026-08-24T13:00:00.000Z"),
  derivadoA: null,
};

describe("escritura contra Supabase real", { skip: !hayCredenciales ? "sin credenciales" : false }, () => {
  before(async () => {
    // Limpieza defensiva: si una corrida anterior se cortó a la mitad, sus
    // filas siguen ahí y falsearían los conteos de esta.
    await limpiar();
  });

  after(async () => {
    await limpiar();
  });

  it("abre una conversación y registra los mensajes", async () => {
    const conv = await obtenerOAbrirConversacion(entrantePrueba("hola"));
    creados.conversaciones.push(conv.id);

    assert.equal(conv.esNueva, true);
    assert.equal(conv.canalUsuarioId, USUARIO_PRUEBA);

    await registrarEntrante(conv.id, entrantePrueba("tengo 3 bolsas de escombros"), {
      intencion: "retiro_no_habitual",
      confianza: 0.92,
    });
    await registrarSaliente(conv.id, decir("Por favor, enviame la foto."), {
      origenRespuesta: "flujo",
      latenciaMs: 120,
    });

    // El trigger de la migración 004 tiene que haber actualizado el contador.
    const { data } = await obtenerCliente()
      .from("conversaciones")
      .select("cantidad_mensajes")
      .eq("id", conv.id)
      .single();
    assert.equal(data?.cantidad_mensajes, 2, "el trigger mantiene el contador");
  });

  it("reutiliza la conversación abierta en lugar de abrir otra", async () => {
    const primera = await obtenerOAbrirConversacion(entrantePrueba("hola"));
    creados.conversaciones.push(primera.id);
    const segunda = await obtenerOAbrirConversacion(entrantePrueba("otra cosa"));
    assert.equal(segunda.id, primera.id);
    assert.equal(segunda.esNueva, false);
  });

  it("crea un ticket con TODAS las columnas mapeadas", async () => {
    const conv = await obtenerOAbrirConversacion(entrantePrueba("hola"));
    creados.conversaciones.push(conv.id);

    const id = await crearTicket(TICKET_BASE, {
      canal: "telegram",
      canalUsuarioId: USUARIO_PRUEBA,
      nombreUsuario: "Prueba Automatizada",
      conversacionId: conv.id,
    });
    creados.tickets.push(id);

    const { data, error } = await obtenerCliente().from("tickets").select("*").eq("id", id).single();
    assert.equal(error, null);

    assert.equal(data!["ticket_type"], "Pedido No Habitual");
    assert.equal(data!["status"], "En Proceso");
    assert.equal(data!["waste_type"], "escombros");
    assert.equal(Number(data!["quantity_value"]), 4);
    assert.equal(data!["quantity_unit"], "bolsas");
    assert.equal(data!["quantity"], "4 bolsas", "la columna legacy de texto también se llena");
    assert.equal(data!["exceeds_limit"], false);
    assert.equal(data!["partial_pickup"], false);
    assert.equal(data!["photo_ref"], "ref-de-prueba-abc");
    assert.equal(data!["photo_url"], null, "la URL la llena el worker, no el flujo");
    assert.equal(data!["channel"], "telegram");
    assert.equal(data!["conversation_id"], conv.id);
    assert.match(data!["address"] as string, /Calle De Prueba 123/);
    assert.ok(data!["sla_deadline"], "el vencimiento se guardó");
  });

  it("REGRESIÓN · el retiro parcial deja constancia en las notas", async () => {
    const id = await crearTicket(
      { ...TICKET_BASE, excedeLimite: true, retiroParcial: true, cantidadValor: 12 },
      { canal: "telegram", canalUsuarioId: USUARIO_PRUEBA, nombreUsuario: null, conversacionId: null },
    );
    creados.tickets.push(id);

    const { data } = await obtenerCliente()
      .from("tickets")
      .select("exceeds_limit, partial_pickup, notes")
      .eq("id", id)
      .single();
    assert.equal(data!["exceeds_limit"], true);
    assert.equal(data!["partial_pickup"], true);
    assert.match(data!["notes"] as string, /Retiro parcial/, "queda por escrito para la cuadrilla");
  });

  it("crea una solicitud de programa", async () => {
    const id = await crearSolicitudPrograma(
      {
        programa: "educa",
        institucion: "Escuela De Prueba",
        responsable: null,
        cantidadAlumnos: 30,
        direccion: "Calle De Prueba 123",
        telefonoContacto: "381 0000000",
        informacionAdicional: "texto libre de prueba",
        fotoReferencia: "ref-solicitud-prueba",
      },
      { canal: "telegram", canalUsuarioId: USUARIO_PRUEBA, nombreUsuario: null, conversacionId: null },
    );
    creados.solicitudes.push(id);

    const { data } = await obtenerCliente()
      .from("program_requests")
      .select("*")
      .eq("id", id)
      .single();
    assert.equal(data!["program_type"], "educa");
    assert.equal(data!["student_count"], 30);
    assert.equal(data!["contact_phone"], "381 0000000");
    assert.equal(
      data!["responsible_person"],
      "No especificado",
      "se respeta el literal del esquema heredado en vez de null",
    );
  });

  it("agrupa preguntas parecidas sin responder", async () => {
    // Es lo que hace útil la vista del panel: cincuenta vecinos preguntando lo
    // mismo tienen que verse como un problema, no como cincuenta.
    const primera = await registrarSinRespuesta({
      pregunta: "donde puedo tirar aceite de cocina usado prueba automatizada",
      motivo: "sin_coincidencia",
      conversacionId: null,
      mensajeId: null,
    });
    creados.sinRespuesta.push(primera.id);
    assert.equal(primera.agrupada, false, "la primera crea fila");

    const segunda = await registrarSinRespuesta({
      pregunta: "donde puedo tirar aceite de cocina usado prueba automatizada",
      motivo: "sin_coincidencia",
      conversacionId: null,
      mensajeId: null,
    });
    assert.equal(segunda.agrupada, true, "la repetida se agrupa");
    assert.equal(segunda.id, primera.id, "y en la MISMA fila");

    const { data } = await obtenerCliente()
      .from("sin_respuesta")
      .select("veces_repetida")
      .eq("id", primera.id)
      .single();
    assert.equal(data!["veces_repetida"], 2);
  });

  it("una pregunta distinta NO se agrupa", async () => {
    const otra = await registrarSinRespuesta({
      pregunta: "cuanto sale el permiso de poda prueba automatizada distinta",
      motivo: "sin_coincidencia",
      conversacionId: null,
      mensajeId: null,
    });
    creados.sinRespuesta.push(otra.id);
    assert.equal(otra.agrupada, false);
  });

  it("aplicarEfectos convierte los efectos declarados en filas", async () => {
    const conv = await obtenerOAbrirConversacion(entrantePrueba("hola"));
    creados.conversaciones.push(conv.id);

    const resultados = await aplicarEfectos(
      [
        { tipo: "crear_ticket", datos: TICKET_BASE },
        { tipo: "guardar_media", referencia: "ref-media-prueba", proposito: "prueba" },
      ],
      { canal: "telegram", canalUsuarioId: USUARIO_PRUEBA, nombreUsuario: null, conversacionId: conv.id },
    );

    assert.equal(resultados.every((r) => r.ok), true, JSON.stringify(resultados));
    const ticketId = idDeTicket(resultados);
    assert.ok(ticketId);
    creados.tickets.push(ticketId!);

    // La descarga quedó encolada para el worker, no ejecutada acá.
    const trabajoId = resultados.find((r) => r.efecto === "guardar_media")?.id;
    const { data } = await obtenerCliente().from("trabajos").select("tipo, prioridad, payload").eq("id", trabajoId!).single();
    assert.equal(data!["tipo"], "descargar_media");
    assert.equal(data!["prioridad"], 10, "las fotos de vecinos van antes que la ingesta del panel");
    await obtenerCliente().from("trabajos").delete().eq("id", trabajoId!);
  });

  it("un efecto que falla no impide que se apliquen los demás", async () => {
    // Regla del módulo: el vecino ya recibió la confirmación, así que un fallo
    // de escritura no puede cortar nada.
    const resultados = await aplicarEfectos(
      [
        // Categoría inválida para la constraint: falla a propósito.
        { tipo: "crear_ticket", datos: { ...TICKET_BASE, tipo: "Tipo Inexistente" as never } },
        { tipo: "crear_solicitud_programa", datos: { programa: "educa", institucion: "Prueba Resiliencia", responsable: null, cantidadAlumnos: null, direccion: "Calle De Prueba 123", telefonoContacto: null, informacionAdicional: null, fotoReferencia: null } },
      ],
      { canal: "telegram", canalUsuarioId: USUARIO_PRUEBA, nombreUsuario: null, conversacionId: null },
    );

    assert.equal(resultados.length, 2, "los dos efectos se intentaron");
    const solicitud = resultados.find((r) => r.efecto === "crear_solicitud_programa")!;
    assert.equal(solicitud.ok, true, "el segundo se aplicó pese al fallo del primero");
    if (solicitud.id) creados.solicitudes.push(solicitud.id);
  });
});

/** Borra todo lo que creó esta suite. Usa service_role, que pasa sobre RLS. */
async function limpiar(): Promise<void> {
  const db = obtenerCliente();
  await db.from("tickets").delete().eq("chat_id", USUARIO_PRUEBA);
  await db.from("program_requests").delete().eq("chat_id", USUARIO_PRUEBA);
  await db.from("sin_respuesta").delete().ilike("pregunta", "%prueba automatizada%");
  // Los mensajes caen por cascada al borrar la conversación.
  await db.from("conversaciones").delete().eq("canal_usuario_id", USUARIO_PRUEBA);
  creados.conversaciones = [];
  creados.tickets = [];
  creados.solicitudes = [];
  creados.sinRespuesta = [];
}
