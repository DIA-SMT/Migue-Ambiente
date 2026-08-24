"use server";

/**
 * Acciones sobre documentos.
 *
 * Son Server Actions y no consultas desde el navegador, por dos razones:
 * corren con la sesión del usuario —así que RLS sigue aplicando igual— y
 * concentran en un lugar las reglas que hay que respetar. La de borrar es el
 * ejemplo: es la que más fácil se hace mal, y acá está escrita una sola vez.
 */
import { revalidatePath } from "next/cache";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";

export interface Resultado {
  readonly ok: boolean;
  readonly mensaje: string;
}

/**
 * Toda acción verifica el padrón de nuevo.
 *
 * Sí, RLS ya lo hace: sin padrón las consultas no devuelven ni tocan nada. Pero
 * una acción que falla por RLS devuelve «0 filas afectadas», que es
 * indistinguible de «el documento no existía». Chequear acá permite dar un
 * mensaje que se entienda.
 */
async function conPermiso(): Promise<
  { ok: true; supabase: Awaited<ReturnType<typeof clienteServidor>>; usuarioId: string } | { ok: false; mensaje: string }
> {
  const persona = await personaActual();
  if (!persona) {
    return { ok: false, mensaje: "Tu cuenta no está habilitada para el panel." };
  }
  return { ok: true, supabase: await clienteServidor(), usuarioId: persona.usuarioId };
}

/**
 * Da de baja o reactiva un documento.
 *
 * Tiene efecto INMEDIATO sobre lo que el bot le responde a un vecino:
 * `buscar_conocimiento` filtra por `d.activo and d.estado = 'listo'` en las tres
 * ramas de la búsqueda. No hace falta reindexar ni esperar al worker.
 *
 * Los fragmentos quedan en la base, pero sólo los ve el personal del panel. Es
 * lo que permite sacar de circulación un borrador interno sin destruir nada.
 */
export async function cambiarActivo(id: string, activo: boolean): Promise<Resultado> {
  const permiso = await conPermiso();
  if (!permiso.ok) return { ok: false, mensaje: permiso.mensaje };

  const { error, data } = await permiso.supabase
    .from("documentos")
    .update({ activo })
    .eq("id", id)
    .select("titulo");

  if (error) return { ok: false, mensaje: `No se pudo cambiar: ${error.message}` };
  if (!data || data.length === 0) {
    return { ok: false, mensaje: "No encontré ese documento." };
  }

  revalidatePath("/documentos");
  return {
    ok: true,
    mensaje: activo
      ? `«${data[0]!.titulo}» vuelve a estar disponible para Migue.`
      : `«${data[0]!.titulo}» ya no se cita. El cambio es inmediato.`,
  };
}

/**
 * Vuelve a encolar la lectura de un documento.
 *
 * Antes de encolar verifica que no haya ya un trabajo esperando para ese
 * documento. Es la misma regla que aplica `encolar_reindexado` en la migración
 * 016: sin ella, dos clics encolan dos trabajos que hacen exactamente lo mismo.
 */
export async function reintentar(id: string): Promise<Resultado> {
  const permiso = await conPermiso();
  if (!permiso.ok) return { ok: false, mensaje: permiso.mensaje };
  const { supabase, usuarioId } = permiso;

  const { data: enCurso, error: errorConsulta } = await supabase
    .from("trabajos")
    .select("id")
    .in("estado", ["pendiente", "tomado"])
    .in("tipo", ["ingestar_documento", "reindexar_documento"])
    .eq("payload->>documento_id", id)
    .limit(1);

  if (errorConsulta) {
    return { ok: false, mensaje: `No pude revisar la cola: ${errorConsulta.message}` };
  }
  if (enCurso && enCurso.length > 0) {
    return { ok: true, mensaje: "Ya había un trabajo esperando para este documento." };
  }

  const { error } = await supabase.from("trabajos").insert({
    tipo: "reindexar_documento",
    payload: { documento_id: id },
    prioridad: 100,
    creado_por: usuarioId,
  });

  if (error) return { ok: false, mensaje: `No se pudo encolar: ${error.message}` };

  // Se devuelve a «pendiente» para que el estado del panel no siga mostrando el
  // error viejo mientras el worker todavía no lo tomó.
  await supabase
    .from("documentos")
    .update({ estado: "pendiente", error_detalle: null })
    .eq("id", id);

  revalidatePath("/documentos");
  return { ok: true, mensaje: "Encolado. El worker lo toma en unos segundos." };
}

/**
 * Borra un documento: la fila, sus fragmentos y el archivo del Storage.
 *
 * NO ES UN DELETE DESDE ACÁ, y esa es la parte importante. La política
 * `panel_gestiona` es `for all`, así que el DELETE está permitido — ahí está la
 * trampa: la fila se iría, y el archivo quedaría en el bucket ocupando cuota
 * para siempre, sin nadie que sepa que existe.
 *
 * El camino correcto es encolar `borrar_documento`, que el worker ejecuta con
 * service_role: borra el archivo y después la fila, en ese orden y por un solo
 * camino. `procesar.ts` lee `ruta_storage` del payload justamente para el caso
 * en que la fila ya no esté.
 *
 * Y se pone `activo = false` en el mismo momento, para que deje de citarse ya
 * en vez de esperar a que pase el worker.
 */
export async function borrar(id: string): Promise<Resultado> {
  const permiso = await conPermiso();
  if (!permiso.ok) return { ok: false, mensaje: permiso.mensaje };
  const { supabase, usuarioId } = permiso;

  const { data: doc, error: errorLectura } = await supabase
    .from("documentos")
    .select("titulo, ruta_storage")
    .eq("id", id)
    .maybeSingle();

  if (errorLectura) return { ok: false, mensaje: `No pude leerlo: ${errorLectura.message}` };
  if (!doc) return { ok: false, mensaje: "No encontré ese documento." };

  const { error } = await supabase.from("trabajos").insert({
    tipo: "borrar_documento",
    payload: { documento_id: id, ruta_storage: doc.ruta_storage },
    // Más urgente que un reindexado: si alguien pidió borrar algo, conviene que
    // desaparezca pronto.
    prioridad: 20,
    creado_por: usuarioId,
  });

  if (error) return { ok: false, mensaje: `No se pudo encolar el borrado: ${error.message}` };

  await supabase.from("documentos").update({ activo: false }).eq("id", id);

  revalidatePath("/documentos");
  return {
    ok: true,
    mensaje: `«${doc.titulo}» dejó de citarse ya y se está borrando del todo.`,
  };
}

/** Guarda título y descripción. No requiere reindexar: no cambia el contenido. */
export async function editarMetadatos(
  id: string,
  titulo: string,
  descripcion: string,
): Promise<Resultado> {
  const permiso = await conPermiso();
  if (!permiso.ok) return { ok: false, mensaje: permiso.mensaje };

  const limpio = titulo.trim();
  if (limpio === "") return { ok: false, mensaje: "El título no puede quedar vacío." };

  const { error } = await permiso.supabase
    .from("documentos")
    .update({ titulo: limpio, descripcion: descripcion.trim() || null })
    .eq("id", id);

  if (error) return { ok: false, mensaje: `No se pudo guardar: ${error.message}` };

  revalidatePath("/documentos");
  revalidatePath(`/documentos/${id}`);
  return { ok: true, mensaje: "Guardado." };
}

/**
 * URL firmada para descargar el original.
 *
 * El bucket es privado, así que no hay URL pública. Se firma por 5 minutos: es
 * un enlace para hacer un clic ahora, no para pegar en un correo.
 */
export async function urlDeDescarga(rutaStorage: string): Promise<string | null> {
  const permiso = await conPermiso();
  if (!permiso.ok) return null;

  const bucket = process.env["NEXT_PUBLIC_SUPABASE_BUCKET_DOCUMENTOS"] ?? "documentos";
  const { data } = await permiso.supabase.storage.from(bucket).createSignedUrl(rutaStorage, 300);
  return data?.signedUrl ?? null;
}
