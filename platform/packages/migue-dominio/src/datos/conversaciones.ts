/**
 * Conversaciones y mensajes: la bitácora del bot.
 *
 * Es lo que alimenta «revisar consultas» y las métricas del panel, y lo que
 * permite auditar por qué el bot contestó lo que contestó. El bot anterior no
 * guardaba nada de esto, y por eso la única evidencia de sus errores son cuatro
 * páginas de capturas de pantalla en un documento de Word.
 */
import { obtenerCliente } from "./cliente.ts";
import { leerConfig, obtenerCatalogo } from "./catalogo.ts";
import { recortar } from "../texto.ts";
import type { Canal, MensajeEntrante, MensajeSaliente } from "../mensajeria.ts";

export interface Conversacion {
  readonly id: string;
  readonly canal: Canal;
  readonly canalUsuarioId: string;
  readonly flujoActivo: string | null;
  readonly cantidadMensajes: number;
  readonly esNueva: boolean;
}

export type OrigenRespuesta =
  | "respuesta_fija"
  | "faq"
  | "documentos"
  | "flujo"
  | "exclusion"
  | "fallback";

export interface TrazaMensaje {
  readonly intencion?: string | null;
  readonly confianza?: number | null;
  readonly origenRespuesta?: OrigenRespuesta | null;
  readonly fragmentosCitados?: readonly string[] | null;
  readonly modelo?: string | null;
  readonly tokensEntrada?: number | null;
  readonly tokensSalida?: number | null;
  readonly costoUsd?: number | null;
  readonly latenciaMs?: number | null;
}

export class ErrorDeEscritura extends Error {
  constructor(tabla: string, detalle: string) {
    super(`No pude escribir en ${tabla}: ${detalle}`);
    this.name = "ErrorDeEscritura";
  }
}

/**
 * Devuelve la conversación abierta del vecino, o abre una nueva.
 *
 * Una conversación abierta pero inactiva por más de la ventana configurada se
 * cierra y se abre otra. Si un vecino vuelve tres días después no es la misma
 * consulta: reutilizar el hilo mezclaría dos cosas distintas y falsearía las
 * métricas de duración y de mensajes por conversación.
 */
export async function obtenerOAbrirConversacion(
  entrante: MensajeEntrante,
): Promise<Conversacion> {
  const db = obtenerCliente();
  const catalogo = await obtenerCatalogo();
  const ventanaHoras = Number(leerConfig(catalogo, "conversacion_ventana_horas", 24));
  const corte = new Date(entrante.recibidoEn.getTime() - ventanaHoras * 3_600_000);

  const { data: abiertas, error } = await db
    .from("conversaciones")
    .select("id, canal, canal_usuario_id, flujo_activo, cantidad_mensajes, ultima_actividad_en")
    .eq("canal", entrante.canal)
    .eq("canal_usuario_id", entrante.canalUsuarioId)
    .eq("estado", "abierta")
    .order("ultima_actividad_en", { ascending: false })
    .limit(1);

  if (error) throw new ErrorDeEscritura("conversaciones", error.message);

  const abierta = abiertas?.[0];
  if (abierta) {
    const vencida = new Date(abierta.ultima_actividad_en as string) < corte;
    if (!vencida) {
      return {
        id: abierta.id as string,
        canal: abierta.canal as Canal,
        canalUsuarioId: abierta.canal_usuario_id as string,
        flujoActivo: (abierta.flujo_activo ?? null) as string | null,
        cantidadMensajes: (abierta.cantidad_mensajes ?? 0) as number,
        esNueva: false,
      };
    }
    // Vencida: se cierra antes de abrir la nueva, así no quedan dos abiertas
    // para el mismo vecino.
    await cerrarConversacion(abierta.id as string, "abandonada");
  }

  const { data: creada, error: errorCrear } = await db
    .from("conversaciones")
    .insert({
      canal: entrante.canal,
      canal_usuario_id: entrante.canalUsuarioId,
      nombre_usuario: entrante.nombreUsuario ?? null,
      telefono: entrante.telefono ?? null,
      iniciada_en: entrante.recibidoEn.toISOString(),
      ultima_actividad_en: entrante.recibidoEn.toISOString(),
    })
    .select("id")
    .single();

  if (errorCrear || !creada) {
    throw new ErrorDeEscritura("conversaciones", errorCrear?.message ?? "sin datos");
  }

  return {
    id: creada.id as string,
    canal: entrante.canal,
    canalUsuarioId: entrante.canalUsuarioId,
    flujoActivo: null,
    cantidadMensajes: 0,
    esNueva: true,
  };
}

/** Registra lo que escribió el vecino. */
export async function registrarEntrante(
  conversacionId: string,
  entrante: MensajeEntrante,
  traza: TrazaMensaje = {},
): Promise<string> {
  return insertarMensaje(conversacionId, {
    direccion: "entrante",
    // Se recorta para que un pegado gigante no infle la tabla.
    texto: entrante.texto === null ? null : recortar(entrante.texto, 4000),
    media_tipo: entrante.media?.tipo ?? null,
    media_ruta: entrante.media?.referencia ?? null,
    creado_en: entrante.recibidoEn.toISOString(),
    ...trazaAColumnas(traza),
  });
}

/**
 * El `origen_respuesta` del último saliente de la conversación.
 *
 * Lo usa el orquestador para saber si ya mostró el menú y el vecino insistió, y
 * entonces derivar a Migue en lugar de repetir el menú — que era un bucle sin
 * salida.
 *
 * Se lee de la BASE y no de un contador en Redis a propósito: el estado del flujo
 * vive en Redis con vencimiento, y un contador que se pierde al vencer haría que
 * el bot vuelva a mostrar el menú para siempre, que es exactamente lo que la
 * derivación viene a cortar. Acá el dato ya está.
 *
 * Devuelve null si la conversación no tiene salientes todavía. Ante un error de
 * lectura devuelve null también, y no lanza: el peor caso es mostrar el menú una
 * vez de más, que es infinitamente mejor que romperle la conversación al vecino
 * por no poder leer una columna.
 */
export async function ultimoOrigenSaliente(conversacionId: string): Promise<string | null> {
  const { data, error } = await obtenerCliente()
    .from("mensajes")
    .select("origen_respuesta")
    .eq("conversacion_id", conversacionId)
    .eq("direccion", "saliente")
    .order("creado_en", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return (data?.origen_respuesta as string | null) ?? null;
}

/** Registra lo que respondió el bot. */
export async function registrarSaliente(
  conversacionId: string,
  saliente: MensajeSaliente,
  traza: TrazaMensaje = {},
): Promise<string> {
  return insertarMensaje(conversacionId, {
    direccion: "saliente",
    texto: recortar(saliente.texto, 4000),
    ...trazaAColumnas(traza),
  });
}

function trazaAColumnas(traza: TrazaMensaje): Record<string, unknown> {
  return {
    intencion: traza.intencion ?? null,
    confianza: traza.confianza ?? null,
    origen_respuesta: traza.origenRespuesta ?? null,
    fragmentos_citados: traza.fragmentosCitados ?? null,
    modelo: traza.modelo ?? null,
    tokens_entrada: traza.tokensEntrada ?? null,
    tokens_salida: traza.tokensSalida ?? null,
    costo_usd: traza.costoUsd ?? null,
    latencia_ms: traza.latenciaMs ?? null,
  };
}

async function insertarMensaje(
  conversacionId: string,
  fila: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await obtenerCliente()
    .from("mensajes")
    .insert({ conversacion_id: conversacionId, ...fila })
    .select("id")
    .single();

  if (error || !data) throw new ErrorDeEscritura("mensajes", error?.message ?? "sin datos");
  return data.id as string;
}

/**
 * Guarda en qué flujo y paso quedó la conversación.
 *
 * Duplica lo que ya vive en Redis, y es deliberado: Redis es el estado caliente
 * y puede vaciarse; esta columna es para que el panel pueda ver, sin tocar
 * Redis, en qué quedó cada conversación abierta.
 */
export async function actualizarFlujo(
  conversacionId: string,
  flujo: string | null,
  paso: string | null,
): Promise<void> {
  const { error } = await obtenerCliente()
    .from("conversaciones")
    .update({ flujo_activo: flujo, paso_actual: paso })
    .eq("id", conversacionId);
  if (error) throw new ErrorDeEscritura("conversaciones", error.message);
}

export async function cerrarConversacion(
  conversacionId: string,
  estado: "cerrada" | "derivada" | "abandonada" = "cerrada",
): Promise<void> {
  const { error } = await obtenerCliente()
    .from("conversaciones")
    .update({
      estado,
      flujo_activo: null,
      paso_actual: null,
      cerrada_en: new Date().toISOString(),
    })
    .eq("id", conversacionId);
  if (error) throw new ErrorDeEscritura("conversaciones", error.message);
}
