/**
 * Escritura de tickets, solicitudes de programa y preguntas sin responder.
 *
 * Las dos primeras tablas vienen del bot anterior en ManyChat y conservan sus
 * nombres de columna en inglés. El mapeo de español a inglés se concentra acá
 * a propósito: es la única frontera donde conviven las dos convenciones, y
 * tenerla en un solo archivo evita que se filtre por todo el código.
 */
import { obtenerCliente } from "./cliente.ts";
import { ErrorDeEscritura } from "./conversaciones.ts";
import { recortar } from "../texto.ts";
import type { Canal } from "../mensajeria.ts";
import type { DatosSolicitudPrograma, DatosTicket } from "../flujos/tipos.ts";

/** Datos del canal que acompañan a todo registro. */
export interface Procedencia {
  readonly canal: Canal;
  readonly canalUsuarioId: string;
  readonly nombreUsuario: string | null;
  readonly conversacionId: string | null;
}

/**
 * Estado inicial de un ticket.
 *
 * Se usa el mismo literal que las 19 filas heredadas de ManyChat («En
 * Proceso»), no una constante nueva: si el panel filtra por estado, tiene que
 * poder listar las viejas y las nuevas con el mismo criterio.
 */
const ESTADO_INICIAL = "En Proceso";

/** Cantidad legible para la columna `quantity`, que en el esquema viejo es texto. */
function cantidadLegible(datos: DatosTicket): string | null {
  if (datos.cantidadValor === null) return null;
  const unidad = datos.cantidadUnidad === "m3" ? "m³" : (datos.cantidadUnidad ?? "");
  return `${datos.cantidadValor} ${unidad}`.trim();
}

export async function crearTicket(
  datos: DatosTicket,
  procedencia: Procedencia,
): Promise<string> {
  const notas: string[] = [];
  if (datos.retiroParcial) {
    notas.push("Retiro parcial: excede el límite gratuito, se retira hasta el máximo permitido.");
  }
  if (datos.derivadoA) notas.push(`Derivado a: ${datos.derivadoA}`);

  const { data, error } = await obtenerCliente()
    .from("tickets")
    .insert({
      ticket_type: datos.tipo,
      status: ESTADO_INICIAL,
      address: recortar(datos.direccion, 500),
      waste_type: datos.tipoResiduo,
      quantity: cantidadLegible(datos),
      quantity_value: datos.cantidadValor,
      quantity_unit: datos.cantidadUnidad,
      exceeds_limit: datos.excedeLimite,
      partial_pickup: datos.retiroParcial,
      days_without_service: datos.diasSinServicio,
      // Referencia del canal, no URL: el worker la resuelve y llena photo_url.
      photo_ref: datos.fotoReferencia,
      sla_deadline: datos.vencimiento.toISOString(),
      derived_to: datos.derivadoA,
      notes: notas.length > 0 ? notas.join(" ") : null,
      channel: procedencia.canal,
      chat_id: procedencia.canalUsuarioId,
      user_name: procedencia.nombreUsuario,
      conversation_id: procedencia.conversacionId,
    })
    .select("id")
    .single();

  if (error || !data) throw new ErrorDeEscritura("tickets", error?.message ?? "sin datos");
  return data.id as string;
}

export async function crearSolicitudPrograma(
  datos: DatosSolicitudPrograma,
  procedencia: Procedencia,
): Promise<string> {
  const { data, error } = await obtenerCliente()
    .from("program_requests")
    .insert({
      program_type: datos.programa,
      // El esquema viejo usa «No especificado» en vez de null para estos dos
      // campos. Se respeta para que el panel muestre una sola cosa.
      institution_name: datos.institucion ?? "No especificado",
      responsible_person: datos.responsable ?? "No especificado",
      student_count: datos.cantidadAlumnos ?? 0,
      address: recortar(datos.direccion, 500),
      contact_phone: datos.telefonoContacto,
      additional_info: datos.informacionAdicional,
      // Sin esto el worker subía la foto al bucket y el update de photo_url no
      // encontraba la fila: la columna existe desde la 012 y nadie la escribía.
      photo_ref: datos.fotoReferencia,
      status: "Pendiente",
      channel: procedencia.canal,
      chat_id: procedencia.canalUsuarioId,
      user_name: procedencia.nombreUsuario,
      conversation_id: procedencia.conversacionId,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new ErrorDeEscritura("program_requests", error?.message ?? "sin datos");
  }
  return data.id as string;
}

// ---------------------------------------------------------------------------
// Preguntas sin responder
// ---------------------------------------------------------------------------

export type MotivoSinRespuesta =
  | "sin_coincidencia"
  | "confianza_baja"
  | "fuera_de_alcance"
  | "error_modelo";

/**
 * Registra una pregunta que el bot no pudo responder.
 *
 * Antes de insertar busca una pregunta parecida ya registrada y, si la
 * encuentra, incrementa su contador en lugar de crear otra fila. Eso es lo que
 * hace útil la vista del panel: sin agrupar, cincuenta vecinos preguntando lo
 * mismo se ven como cincuenta problemas distintos y no como el único que es.
 *
 * La similitud la calcula Postgres con trigram, no la aplicación: es la misma
 * función que usa el índice, así que agrupa igual que buscaría un operador.
 */
export async function registrarSinRespuesta(opciones: {
  readonly pregunta: string;
  readonly motivo: MotivoSinRespuesta;
  readonly conversacionId: string | null;
  readonly mensajeId: string | null;
  readonly confianza?: number | null;
  readonly umbralSimilitud?: number;
}): Promise<{ id: string; agrupada: boolean }> {
  // La agrupación por similitud se resuelve con una función en la base
  // (migración 013) y no acá: PostgREST no expresa bien el operador trigram, y
  // hacerlo en dos viajes —buscar y después insertar— abre una carrera donde
  // dos mensajes simultáneos crean dos filas para la misma pregunta.
  const { data, error } = await obtenerCliente()
    .rpc("agrupar_sin_respuesta", {
      p_pregunta: recortar(opciones.pregunta, 500),
      p_motivo: opciones.motivo,
      p_conversacion_id: opciones.conversacionId,
      p_mensaje_id: opciones.mensajeId,
      p_confianza: opciones.confianza ?? null,
      p_umbral: opciones.umbralSimilitud ?? 0.6,
    })
    .single();

  if (error || !data) {
    throw new ErrorDeEscritura("sin_respuesta", error?.message ?? "sin datos");
  }

  const fila = data as { id: string; agrupada: boolean };
  return { id: fila.id, agrupada: fila.agrupada };
}
