"use server";

/**
 * Acciones sobre pedidos, reclamos y solicitudes de programas.
 *
 * Estas tablas guardan datos de vecinos —nombre, teléfono, dirección— así que
 * las políticas de RLS son más restrictivas que en el resto: se puede leer y
 * actualizar, pero NO borrar. Son el respaldo documental de un trámite
 * municipal, y un pedido de supresión se ejecuta con service_role y queda
 * asentado, no con un clic.
 */
import { revalidatePath } from "next/cache";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";

export interface Resultado {
  readonly ok: boolean;
  readonly mensaje: string;
}

async function conPermiso() {
  const persona = await personaActual();
  if (!persona) return null;
  return { supabase: await clienteServidor(), persona };
}

/**
 * Cambia el estado de un caso.
 *
 * `resolved_at` se maneja acá y no se le pide a quien opera: si el estado pasa a
 * uno terminal, se sella la fecha; si vuelve a abrirse, se limpia. Dejarlo a
 * mano garantizaría casos «resueltos» sin fecha, que después no se pueden contar
 * en las métricas.
 */
const TERMINALES = new Set(["Resuelto", "No corresponde"]);

export async function cambiarEstado(
  tabla: "tickets" | "program_requests",
  id: string,
  estado: string,
): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const cambio: Record<string, unknown> = {
    status: estado,
    resolved_at: TERMINALES.has(estado) ? new Date().toISOString() : null,
  };

  const { error, data } = await acceso.supabase
    .from(tabla)
    .update(cambio)
    .eq("id", id)
    .select("id");

  if (error) {
    return {
      ok: false,
      mensaje: /row-level security/i.test(error.message)
        ? "No tenés permiso para modificar casos."
        : error.message,
    };
  }
  if (!data || data.length === 0) return { ok: false, mensaje: "No encontré ese caso." };

  revalidatePath("/casos");
  return {
    ok: true,
    mensaje: TERMINALES.has(estado) ? `Marcado como ${estado.toLowerCase()}.` : `Pasó a ${estado}.`,
  };
}

/**
 * Guarda una nota interna sobre el caso.
 *
 * Es el único campo de texto que el panel escribe en estas tablas. El resto lo
 * cargó el vecino a través del bot y cambiarlo sería reescribir lo que dijo.
 */
export async function guardarNota(id: string, notas: string): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  // El `.select("id")` no es decorativo: es lo que permite saber si se escribió
  // algo. El RLS de Postgres FILTRA filas en el `using`, no lanza excepción, así
  // que un UPDATE que no alcanza ninguna fila vuelve sin error y con cero filas.
  // Sin esto, alguien a quien dieron de baja del padrón después de abrir la
  // pantalla escribía su nota, veía «Nota guardada.» en verde, y no se había
  // guardado nada. `cambiarEstado` ya lo hacía diez líneas más arriba; esta
  // función se quedó atrás.
  const { error, data } = await acceso.supabase
    .from("tickets")
    .update({ notes: notas.trim() || null })
    .eq("id", id)
    .select("id");

  if (error) {
    return {
      ok: false,
      mensaje: /row-level security/i.test(error.message)
        ? "No tenés permiso para escribir notas."
        : error.message,
    };
  }
  if (!data || data.length === 0) {
    return { ok: false, mensaje: "No pude guardar la nota: no encontré ese caso." };
  }

  revalidatePath("/casos");
  return { ok: true, mensaje: "Nota guardada." };
}

/**
 * URL firmada para ver la foto que mandó el vecino.
 *
 * El bucket `media` es privado: son fotos de la propiedad de una persona. Se
 * firma por cinco minutos, que alcanza para mirarla y no para compartir un
 * enlace permanente.
 *
 * Devuelve null cuando `photo_url` está vacío, que es el caso mientras el worker
 * todavía no bajó el archivo del canal.
 */
export async function urlDeFoto(rutaEnBucket: string | null): Promise<string | null> {
  if (!rutaEnBucket) return null;
  const acceso = await conPermiso();
  if (!acceso) return null;

  const bucket = process.env["NEXT_PUBLIC_SUPABASE_BUCKET_MEDIA"] ?? "media";
  const { data } = await acceso.supabase.storage.from(bucket).createSignedUrl(rutaEnBucket, 300);
  return data?.signedUrl ?? null;
}
