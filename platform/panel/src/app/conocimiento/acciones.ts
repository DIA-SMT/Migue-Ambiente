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
import { marcadoresDe, marcadoresQueNoSeResuelven } from "@migue/dominio/compartido";
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
  revalidatePath("/conocimiento");
}

/**
 * Rechaza los marcadores en una respuesta escrita por el área.
 *
 * Ni las preguntas frecuentes ni las respuestas textuales pasan por
 * `interpolar()`: eso ocurre en dos pasos de flujo y en ningún otro lado. Una
 * textual se envía tal cual, así que `{empresa}` le llega al vecino con las
 * llaves; una frecuente entra al modelo como material y puede salir copiada
 * igual.
 *
 * La validación se agrega ahora porque las cuatro cosas quedaron en la misma
 * pantalla: alguien va a ver `{empresa}` en un mensaje de confirmación y probarlo
 * acá, razonablemente. Mejor decirle que no funciona que dejarlo descubrir por
 * un vecino.
 */
function sinMarcadores(texto: string): Resultado | null {
  const usados = [...new Set([...texto.matchAll(/\{[a-zA-Z_]+\}/g)].map((m) => m[0]))];
  if (usados.length === 0) return null;
  return {
    ok: false,
    mensaje:
      `${usados.join(", ")} no se reemplaza en una respuesta: se le enviaría al vecino con las ` +
      `llaves puestas. Los marcadores sólo funcionan en los mensajes de confirmación de un ` +
      `trámite, en «Cómo habla Migue».`,
  };
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

  const conLlaves = sinMarcadores(respuesta);
  if (conLlaves) return conLlaves;

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

  const conLlaves = sinMarcadores(respuesta);
  if (conLlaves) return conLlaves;
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

/* --------------------------------------------- resolver lo que no supo ----- */

/**
 * Escribe una respuesta Y marca la pregunta como resuelta, en una transacción.
 *
 * Va por RPC (`resolver_con_faq`, migración 021) y no con dos llamadas seguidas
 * porque PostgREST hace cada petición en su propia transacción: si la segunda
 * fallara quedaría la respuesta escrita y la pregunta todavía en la lista, y
 * alguien la volvería a responder. Dos respuestas para lo mismo compitiendo en
 * el ranking del buscador es peor que ninguna.
 *
 * La función de la base decide si puede publicar: un operador que marque
 * «publicar» obtiene un borrador, y el mensaje se lo dice. Guardar el trabajo y
 * avisar es mejor que rechazarlo.
 */
export async function resolverConFaq(entrada: {
  sinRespuestaId: string;
  pregunta: string;
  respuesta: string;
  etiquetas: string;
  activa: boolean;
}): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const etiquetas = entrada.etiquetas
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");

  const { data, error } = await acceso.supabase.rpc("resolver_con_faq", {
    p_sin_respuesta_id: entrada.sinRespuestaId,
    p_pregunta: entrada.pregunta.trim(),
    p_respuesta: entrada.respuesta.trim(),
    p_etiquetas: etiquetas,
    p_publicar: entrada.activa,
  });

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };

  const fila = (Array.isArray(data) ? data[0] : data) as { publicada?: boolean } | undefined;
  refrescar();
  return {
    ok: true,
    mensaje: fila?.publicada
      ? "Respondida y publicada. Si vuelven a preguntar lo mismo, Migue ya sabe."
      : entrada.activa
        ? "Guardada como borrador: publicar es de supervisor. La pregunta queda tomada, pero Migue todavía no la usa."
        : "Guardada como borrador. Falta que un supervisor la publique para que Migue la use.",
  };
}

/** Igual que la anterior, con una respuesta textual. */
export async function resolverConFija(entrada: {
  sinRespuestaId: string;
  nombre: string;
  disparadores: string;
  modo: ModoDisparador;
  respuesta: string;
  activa: boolean;
  notas: string;
}): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const disparadores = entrada.disparadores
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
  if (disparadores.length === 0) {
    return { ok: false, mensaje: "Hace falta al menos un disparador." };
  }

  const { data, error } = await acceso.supabase.rpc("resolver_con_fija", {
    p_sin_respuesta_id: entrada.sinRespuestaId,
    p_nombre: entrada.nombre.trim(),
    p_disparadores: disparadores,
    p_modo: entrada.modo,
    p_respuesta: entrada.respuesta.trim(),
    p_publicar: entrada.activa,
    p_notas: entrada.notas.trim() || null,
  });

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };

  const fila = (Array.isArray(data) ? data[0] : data) as { publicada?: boolean } | undefined;
  refrescar();
  return {
    ok: true,
    mensaje: fila?.publicada
      ? "Respondida y publicada."
      : "Guardada como borrador. Falta que un supervisor la publique.",
  };
}

/**
 * Descarta una pregunta sin escribir nada.
 *
 * No borra la fila: la deja con el motivo. Descartar de más es un error
 * recuperable sólo si queda registro de qué se descartó.
 */
export async function descartarPregunta(id: string, motivo: string): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const { error } = await acceso.supabase.rpc("descartar_sin_respuesta", {
    p_sin_respuesta_id: id,
    p_motivo: motivo.trim() || null,
  });

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  refrescar();
  return { ok: true, mensaje: "Descartada. Queda registrada por si hay que revisarla." };
}

/* ---------------------------------------------- lo que Migue dice fijo --- */

/**
 * Guardar uno de los textos fijos del bot.
 *
 * Es la acción más directa del panel: lo que se guarda acá es literalmente lo
 * que lee un vecino, sin modelo en el medio. Valida dos cosas antes de escribir,
 * y las dos vienen de fallas reales:
 *
 *   1. Que no queden marcadores que el bot no sepa reemplazar. Un `{plazo}` mal
 *      escrito como `{palzo}` se le envía LITERAL, con las llaves puestas.
 *   2. Que no se vacíe una clave obligatoria. El código las lee con
 *      `leerTexto()`, que devuelve «[falta texto: clave]» cuando no hay nada, y
 *      eso también se le manda al vecino.
 *
 * Si una clave puede ir vacía lo dice la BASE, en la columna `opcional`. Antes
 * era una constante en este archivo con una sola clave, y ya estaba
 * desincronizada: producción tiene cinco. El efecto concreto era que vaciar
 * `seguimiento_tras_responder` —la forma documentada de apagar el voto del
 * vecino— lo rechazaba el panel diciendo que no podía quedar vacío.
 *
 * Y los marcadores se validan POR CLAVE, con `marcadoresQueNoSeResuelven()` del
 * dominio. La validación anterior comprobaba que el marcador estuviera en
 * `marcadores_disponibles` —o sea que el nombre fuera de uno real— pero no que
 * la clave donde se escribió llegara a interpolarse. `interpolar()` se llama en
 * exactamente DOS lugares del bot, los pasos de confirmación de los dos
 * trámites; en las otras diecinueve claves un `{plazo}` perfectamente escrito le
 * llega al vecino con las llaves puestas. Eso se guardaba sin protestar.
 */
export async function guardarTexto(clave: string, texto: string): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const limpio = texto.trim();

  if (limpio === "") {
    // Se consulta la fila, no una lista local. Una clave que no existe también
    // cae acá, y el mensaje siguiente es el correcto para ese caso.
    const { data: fila } = await acceso.supabase
      .from("textos_bot")
      .select("opcional")
      .eq("clave", clave)
      .maybeSingle();

    if (!fila) return { ok: false, mensaje: "No encontré ese texto." };
    if (!fila.opcional) {
      return {
        ok: false,
        mensaje:
          "Este mensaje no puede quedar vacío: el bot lo busca y, si no lo encuentra, le manda al " +
          "vecino un aviso de error en su lugar.",
      };
    }
  }

  const invalidos = marcadoresQueNoSeResuelven(clave, limpio);
  if (invalidos.length > 0) {
    const admite = marcadoresDe(clave);
    return {
      ok: false,
      mensaje:
        admite.length === 0
          ? `Este mensaje no acepta marcadores: ${invalidos.join(", ")} se le enviaría al vecino ` +
            `con las llaves puestas. Sólo los mensajes de confirmación de un trámite los resuelven.`
          : `${invalidos.join(", ")} no ${invalidos.length === 1 ? "es un marcador" : "son marcadores"} ` +
            `que el bot sepa reemplazar acá, así que se lo enviaría al vecino con las llaves ` +
            `puestas. En este mensaje valen: ${admite.join(", ")}`,
    };
  }

  const { error, data } = await acceso.supabase
    .from("textos_bot")
    .update({ texto: limpio, actualizado_por: acceso.persona.usuarioId })
    .eq("clave", clave)
    .select("clave");

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  if (!data || data.length === 0) return { ok: false, mensaje: "No encontré ese texto." };

  refrescar();
  return {
    ok: true,
    mensaje:
      limpio === ""
        ? "Vaciado. El bot deja de enviar este mensaje."
        : "Guardado. El bot lo usa desde el próximo mensaje.",
  };
}
