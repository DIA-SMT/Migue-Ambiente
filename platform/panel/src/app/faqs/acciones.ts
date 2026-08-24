"use server";

/**
 * Acciones sobre FAQs y respuestas fijas.
 *
 * La regla que gobierna todo acá es de la migración 019: cargar y editar
 * borradores lo puede hacer cualquiera del padrón, PUBLICAR es de supervisor o
 * admin. Está en las políticas de RLS, no acá — este código sólo traduce el
 * error de política a un mensaje que se entienda.
 */
import { revalidatePath } from "next/cache";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import type { Coincidencia, ModoDisparador, PruebaDisparadores } from "@/lib/tipos";

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
 * Traduce un error de Postgres a algo que le sirva a quien lo lee.
 *
 * El caso que importa es el 42501: es lo que devuelve RLS cuando un operador
 * intenta publicar. Sin traducirlo, el panel mostraría «new row violates
 * row-level security policy», que no le dice a nadie que le falta un permiso.
 */
function traducir(mensaje: string, codigo: string | undefined): string {
  if (codigo === "42501" || /row-level security/i.test(mensaje)) {
    return "Para publicar hace falta ser supervisor. Podés guardarlo como borrador y pedir que lo revisen.";
  }
  if (/duplicate key/i.test(mensaje)) return "Ya existe una con ese nombre.";
  return mensaje;
}

function refrescar() {
  revalidatePath("/faqs");
}

/* ------------------------------------------------------------------- FAQs --- */

export async function guardarFaq(entrada: {
  id: string | null;
  pregunta: string;
  respuesta: string;
  etiquetas: string;
  activa: boolean;
}): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const pregunta = entrada.pregunta.trim();
  const respuesta = entrada.respuesta.trim();
  if (pregunta === "" || respuesta === "") {
    return { ok: false, mensaje: "La pregunta y la respuesta no pueden quedar vacías." };
  }

  // Las etiquetas llegan como texto separado por comas: es la forma más simple
  // de escribirlas y la columna es un array de text.
  const etiquetas = entrada.etiquetas
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");

  const fila = { pregunta, respuesta, etiquetas, activa: entrada.activa };

  const { error } =
    entrada.id === null
      ? await acceso.supabase
          .from("faqs")
          .insert({ ...fila, creada_por: acceso.persona.usuarioId })
      : await acceso.supabase.from("faqs").update(fila).eq("id", entrada.id);

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };

  refrescar();
  return {
    ok: true,
    mensaje: entrada.activa
      ? "Publicada. Migue ya la puede usar."
      : "Guardada como borrador. Migue todavía no la usa.",
  };
}

export async function publicarFaq(id: string, activa: boolean): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const { error } = await acceso.supabase.from("faqs").update({ activa }).eq("id", id);
  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };

  refrescar();
  return {
    ok: true,
    mensaje: activa ? "Publicada. Migue ya la puede usar." : "Despublicada. Migue deja de usarla.",
  };
}

export async function borrarFaq(id: string): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const { error, data } = await acceso.supabase.from("faqs").delete().eq("id", id).select("id");
  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };

  // RLS no lanza error cuando el DELETE no alcanza ninguna fila: devuelve cero.
  // Sin este chequeo, un operador vería «borrada» y la fila seguiría ahí.
  if (!data || data.length === 0) {
    return { ok: false, mensaje: "Borrar una respuesta es una acción de administrador." };
  }

  refrescar();
  return { ok: true, mensaje: "Borrada." };
}

/* -------------------------------------------------------- respuestas fijas --- */

export async function guardarFija(entrada: {
  id: string | null;
  nombre: string;
  disparadores: string;
  modo: ModoDisparador;
  respuesta: string;
  activa: boolean;
  notas: string;
}): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const nombre = entrada.nombre.trim();
  const respuesta = entrada.respuesta.trim();
  const disparadores = entrada.disparadores
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");

  if (nombre === "" || respuesta === "") {
    return { ok: false, mensaje: "El nombre y la respuesta no pueden quedar vacías." };
  }
  if (disparadores.length === 0) {
    // La tabla tiene un check que lo exige; validarlo acá da un mensaje legible.
    return { ok: false, mensaje: "Hace falta al menos un disparador." };
  }

  const fila = {
    nombre,
    disparadores,
    modo: entrada.modo,
    respuesta,
    activa: entrada.activa,
    notas: entrada.notas.trim() || null,
  };

  const { error } =
    entrada.id === null
      ? await acceso.supabase
          .from("respuestas_fijas")
          .insert({ ...fila, creada_por: acceso.persona.usuarioId })
      : await acceso.supabase.from("respuestas_fijas").update(fila).eq("id", entrada.id);

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };

  refrescar();
  return {
    ok: true,
    mensaje: entrada.activa
      ? "Publicada. Se envía textual cuando coincida un disparador."
      : "Guardada como borrador.",
  };
}

export async function publicarFija(id: string, activa: boolean): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const { error } = await acceso.supabase.from("respuestas_fijas").update({ activa }).eq("id", id);
  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };

  refrescar();
  return { ok: true, mensaje: activa ? "Publicada." : "Despublicada." };
}

export async function borrarFija(id: string): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const { error, data } = await acceso.supabase
    .from("respuestas_fijas")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  if (!data || data.length === 0) {
    return { ok: false, mensaje: "Borrar una respuesta es una acción de administrador." };
  }

  refrescar();
  return { ok: true, mensaje: "Borrada." };
}

/* ------------------------------------------------------------------ probar --- */

/**
 * Prueba los disparadores de una respuesta fija SIN publicar nada.
 *
 * Lo importante que devuelve no es si coincide con el texto de prueba: es
 * cuántos de los últimos mensajes reales habría atrapado. Un disparador puede
 * parecer razonable y atrapar todo.
 */
export async function probarDisparadores(
  disparadores: string,
  modo: ModoDisparador,
  texto: string,
): Promise<{ ok: true; prueba: PruebaDisparadores } | { ok: false; mensaje: string }> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const lista = disparadores
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
  if (lista.length === 0) return { ok: false, mensaje: "Escribí al menos un disparador." };

  const { data, error } = await acceso.supabase.rpc("probar_disparadores", {
    p_disparadores: lista,
    p_modo: modo,
    p_texto: texto.trim() || null,
  });

  if (error) {
    // Una expresión regular mal escrita la rechaza Postgres al evaluarla. Es
    // exactamente para lo que existe esta prueba.
    return {
      ok: false,
      mensaje: /invalid regular expression/i.test(error.message)
        ? `La expresión regular no es válida: ${error.message}`
        : error.message,
    };
  }

  const prueba = (Array.isArray(data) ? data[0] : data) as PruebaDisparadores | undefined;
  if (!prueba) return { ok: false, mensaje: "La prueba no devolvió nada." };
  return { ok: true, prueba };
}

/**
 * Corre una consulta contra el buscador REAL del bot.
 *
 * Usa `probar_conocimiento` (migración 018), que delega en la misma
 * `buscar_conocimiento` que usa el bot. No es una simulación parecida: es la
 * misma función. Si fuera una copia, el panel probaría una cosa y el vecino
 * recibiría otra.
 *
 * Lo que NO hace es llamar al modelo: muestra el material que Migue encontraría,
 * no la respuesta que redactaría. Es a propósito — el material es lo que se
 * puede corregir desde acá.
 */
export async function probarBusqueda(
  consulta: string,
): Promise<{ ok: true; coincidencias: Coincidencia[] } | { ok: false; mensaje: string }> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };
  if (consulta.trim() === "") return { ok: false, mensaje: "Escribí una consulta." };

  const { data, error } = await acceso.supabase.rpc("probar_conocimiento", {
    p_consulta: consulta.trim(),
    p_limite: 8,
  });

  if (error) return { ok: false, mensaje: error.message };
  return { ok: true, coincidencias: (data ?? []) as Coincidencia[] };
}
