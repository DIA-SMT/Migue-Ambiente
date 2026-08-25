"use server";

/**
 * Guardar y probar las reglas del bot.
 *
 * Los dos probadores de este archivo importan las funciones REALES del dominio,
 * las mismas que corre el bot. No es una comodidad: es el único modo de que no
 * mientan.
 *
 * El caso concreto: para probar palabras de exclusión existía la tentación de
 * reusar `probar_disparadores()` de la migración 019, que ya está en la base.
 * Compara con `position()`, o sea SUBCADENA, mientras que el bot compara con
 * `contienePalabra()` — palabra completa, con lookarounds Unicode y sufijo plural
 * opcional. Con la palabra «gas», la RPC daría por atrapados «gasnor»,
 * «gaseoso» y «desgaste»; el bot no atrapa ninguno. Un probador basado en esa
 * RPC le mostraría falsos positivos al operador y lo llevaría a borrar palabras
 * que funcionan bien.
 *
 * Es el mismo criterio con el que la 018 hizo que `probar_conocimiento` delegue
 * en `buscar_conocimiento` en vez de copiarla.
 */
import { revalidatePath } from "next/cache";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import {
  DEFINICIONES,
  validarValor,
  type DefinicionClave,
} from "@/lib/reglas";
import {
  esUtilizable,
  evaluarTodasLasExclusiones,
  interpretarCantidad,
  limiteDe,
  validarVolumen,
  type Categoria,
  type LimiteVolumen,
  type ReglaExclusion,
} from "@migue/dominio";

export interface Resultado {
  readonly ok: boolean;
  readonly mensaje: string;
}

async function conPermiso() {
  const persona = await personaActual();
  if (!persona) return null;
  return { supabase: await clienteServidor(), persona };
}

function traducir(mensaje: string, codigo: string | undefined): string {
  if (codigo === "42501" || /row-level security/i.test(mensaje)) {
    return "No tenés permiso para cambiar las reglas del bot.";
  }
  if (codigo === "23514") {
    // Un CHECK de la base. Pasa con `limites_volumen.categoria`, que sólo admite
    // tres valores, y con `reglas_exclusion.accion`.
    return "La base rechazó ese valor: no es uno de los que admite esa columna.";
  }
  return mensaje;
}

function refrescar() {
  revalidatePath("/reglas");
}

/* --------------------------------------------------------- configuracion --- */

/**
 * Guardar una clave de configuración.
 *
 * La validación es por CLAVE y del lado del panel, no un CHECK de la base. Un
 * CHECK devuelve un 23514 con un mensaje que nadie entiende, y la pantalla igual
 * tendría que validar antes para poder explicar en castellano. Y lo que hay que
 * explicar no es «el valor es inválido» sino «esto hace que el bot se caiga en el
 * último paso del pedido, después de que el vecino mandó la foto».
 */
export async function guardarConfig(clave: string, crudo: string): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const def: DefinicionClave | undefined = DEFINICIONES.get(clave);
  if (!def) {
    // Una clave que la base tiene y esta pantalla no conoce. No se guarda a
    // ciegas: sin definición no hay validación, y es justamente el caso donde un
    // valor mal puesto pasa sin que nada lo note.
    return {
      ok: false,
      mensaje:
        `No conozco la regla «${clave}», así que no puedo validar lo que se escriba. ` +
        `Hay que agregarla a la pantalla antes de poder editarla desde acá.`,
    };
  }

  if (def.huerfana) {
    // Se puede guardar —es un dato de la tabla— pero se avisa que no hace nada.
    // Rechazarlo sería peor: el valor quedaría inconsistente con lo que muestra
    // la pantalla y nadie sabría por qué.
    const v = validarValor(def, crudo);
    if (!v.ok) return { ok: false, mensaje: v.mensaje };
    const { error } = await acceso.supabase
      .from("configuracion")
      .update({ valor: v.valor, actualizado_por: acceso.persona.usuarioId })
      .eq("clave", clave);
    if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
    refrescar();
    return {
      ok: true,
      mensaje: "Guardado, pero el bot no lee esta regla: su comportamiento no va a cambiar.",
    };
  }

  const v = validarValor(def, crudo);
  if (!v.ok) return { ok: false, mensaje: v.mensaje };

  const { error, data } = await acceso.supabase
    .from("configuracion")
    .update({ valor: v.valor, actualizado_por: acceso.persona.usuarioId })
    .eq("clave", clave)
    .select("clave");

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  if (!data || data.length === 0) return { ok: false, mensaje: "No encontré esa regla." };

  refrescar();
  return {
    ok: true,
    mensaje: "Guardado. El bot lo toma dentro de un minuto: tiene el catálogo en caché.",
  };
}

/* ------------------------------------------------------ limites_volumen --- */

export async function guardarLimite(entrada: {
  // `limites_volumen` NO tiene columna `id`: su clave primaria es `categoria`.
  // Usar `id` acá habría hecho que ningún guardado alcance ninguna fila, y como
  // PostgREST no falla cuando un UPDATE toca cero filas, el panel habría dicho
  // «no encontré ese límite» para todos.
  categoria: Categoria;
  limiteValor: string;
  accionAlExceder: string;
  textoExceso: string;
  activo: boolean;
}): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  if (!/^\d+([.,]\d+)?$/.test(entrada.limiteValor.trim())) {
    return { ok: false, mensaje: "El límite tiene que ser un número positivo." };
  }
  const valor = Number(entrada.limiteValor.replace(",", "."));
  if (valor <= 0) return { ok: false, mensaje: "El límite tiene que ser mayor que cero." };

  if (!["parcial_con_ticket", "derivar_sin_ticket"].includes(entrada.accionAlExceder)) {
    return { ok: false, mensaje: "Esa acción no existe." };
  }

  const { error, data } = await acceso.supabase
    .from("limites_volumen")
    .update({
      limite_valor: valor,
      accion_al_exceder: entrada.accionAlExceder,
      texto_exceso: entrada.textoExceso.trim() || null,
      activo: entrada.activo,
    })
    .eq("categoria", entrada.categoria)
    .select("categoria, activo");

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  if (!data || data.length === 0) return { ok: false, mensaje: "No encontré ese límite." };

  refrescar();
  return {
    ok: true,
    mensaje: entrada.activo
      ? "Guardado. El bot lo toma dentro de un minuto."
      : `Guardado. OJO: con «${data[0]!.categoria}» desactivado, un pedido de esa categoría se ` +
        `cae en el último paso, después de que el vecino mandó la foto.`,
  };
}

/* ----------------------------------------------------- reglas_exclusion --- */

export async function guardarExclusion(entrada: {
  id: string | null;
  nombre: string;
  palabras: string;
  respuesta: string;
  prioridad: string;
  activa: boolean;
}): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const nombre = entrada.nombre.trim();
  const respuesta = entrada.respuesta.trim();
  const palabras = entrada.palabras
    .split(/[\n,]/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== "");

  if (nombre === "") return { ok: false, mensaje: "Ponele un nombre a la regla." };
  if (respuesta === "") {
    return {
      ok: false,
      mensaje: "Falta la respuesta: es lo que el vecino va a recibir cuando se derive.",
    };
  }
  if (palabras.length === 0) return { ok: false, mensaje: "Hace falta al menos una palabra." };
  if (!/^\d+$/.test(entrada.prioridad.trim())) {
    return { ok: false, mensaje: "La prioridad tiene que ser un número entero." };
  }

  const fila = {
    nombre,
    palabras,
    respuesta,
    // Siempre 'derivar'. La columna admite 'advertir' y el orquestador la
    // IGNORA: `corta()` es `accion === 'derivar'`, así que una regla en
    // 'advertir' coincide, se evalúa, y el resultado se descarta sin mandar nada
    // ni registrar nada. Ofrecerla sería un botón desconectado.
    accion: "derivar",
    prioridad: Number(entrada.prioridad),
    activa: entrada.activa,
  };

  const { error, data } =
    entrada.id === null
      ? await acceso.supabase.from("reglas_exclusion").insert(fila).select("id")
      : await acceso.supabase
          .from("reglas_exclusion")
          .update(fila)
          .eq("id", entrada.id)
          .select("id");

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  if (!data || data.length === 0) return { ok: false, mensaje: "No pude guardar la regla." };

  refrescar();
  return { ok: true, mensaje: "Guardada. El bot la toma dentro de un minuto." };
}

export async function borrarExclusion(id: string): Promise<Resultado> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const { error, data } = await acceso.supabase
    .from("reglas_exclusion")
    .delete()
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, mensaje: traducir(error.message, error.code) };
  if (!data || data.length === 0) {
    return { ok: false, mensaje: "No se borró nada: puede ser un permiso." };
  }
  refrescar();
  return { ok: true, mensaje: "Borrada." };
}

/**
 * Probar las palabras de exclusión contra un texto, con la función del bot.
 *
 * Usa `evaluarTodasLasExclusiones` del dominio, que es exactamente lo que corre
 * el orquestador. Devuelve TODAS las coincidencias y no sólo la primera, porque
 * lo que hay que ver antes de guardar es si una palabra nueva pisa una regla de
 * mayor prioridad.
 */
export async function probarExclusiones(
  texto: string,
  reglas: readonly ReglaExclusion[],
): Promise<
  | {
      ok: true;
      coincidencias: { nombre: string; palabra: string; prioridad: number; corta: boolean }[];
    }
  | { ok: false; mensaje: string }
> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };
  if (texto.trim() === "") return { ok: false, mensaje: "Escribí un mensaje de prueba." };

  const todas = evaluarTodasLasExclusiones(texto, reglas);

  return {
    ok: true,
    coincidencias: todas.map((c) => ({
      nombre: c.regla.nombre,
      palabra: c.palabra,
      prioridad: c.regla.prioridad,
      // La primera de mayor prioridad es la que corta la conversación; las demás
      // coinciden y no se usan. Mostrarlo evita la conclusión equivocada de que
      // una regla no funciona cuando en realidad otra le gana.
      corta: c.regla.accion === "derivar",
    })),
  };
}

/**
 * Simular qué haría el bot con una cantidad declarada por un vecino.
 *
 * Existe porque `limites_volumen` NO decide sola. Dos constantes del código
 * intervienen y no se ven desde ninguna parte: la conversión de bolsas a metros
 * cúbicos, y un margen de duda alrededor del límite que hace que un valor
 * cercano caiga en «preguntar» en lugar de resolverse. Un operador que baje el
 * límite de voluminosos y vea que el bot pregunta de más no tendría forma de
 * entender por qué.
 *
 * Se muestra el EFECTO en vez de exponer las constantes: lo que hace falta saber
 * es qué va a pasar con «3 bolsas», no que el factor sea 0,04.
 */
export async function simularVolumen(
  categoria: Categoria,
  frase: string,
  limites: readonly LimiteVolumen[],
): Promise<
  | { ok: true; resumen: string; detalle: string; tono: string }
  | { ok: false; mensaje: string }
> {
  const acceso = await conPermiso();
  if (!acceso) return { ok: false, mensaje: "Tu cuenta no está habilitada." };
  if (frase.trim() === "") return { ok: false, mensaje: "Escribí una cantidad, como «3 bolsas»." };

  // Se busca el límite ACTIVO de la categoría, igual que el flujo. Si no hay,
  // el flujo aborta — y eso es lo que se quiere mostrar, no un error del panel.
  const limite = limiteDe(categoria, limites);
  if (limite === null) {
    return {
      ok: true,
      tono: "alerta",
      resumen: "No hay límite activo para esa categoría",
      detalle:
        "Un pedido de esta categoría se caería en el último paso, después de que el vecino ya " +
        "mandó la foto y la dirección, y quedaría sin ticket. Es lo que pasa si el límite está " +
        "desactivado: el switch parece inocuo y no lo es.",
    };
  }

  const cantidad = interpretarCantidad(frase);
  if (!esUtilizable(cantidad)) {
    return {
      ok: true,
      tono: "curso",
      resumen: "Migue no entendería esa cantidad",
      detalle:
        cantidad.vaga !== null
          ? `Interpretaría «${cantidad.vaga}» como algo impreciso y volvería a preguntar cuánto ` +
            `es. Probá con un número y una unidad: «3 bolsas», «2 metros cúbicos».`
          : "Le volvería a preguntar cuánto es. Probá con algo como «3 bolsas», " +
            "«media camionada» o «2 metros cúbicos».",
    };
  }

  const resultado = validarVolumen(cantidad, limite);

  if (resultado.tipo === "dentro") {
    return {
      ok: true,
      tono: "ok",
      resumen: `Entra: ${resultado.valorEvaluado} ${resultado.unidadEvaluada} de ${limite.limiteValor} ${limite.limiteUnidad}`,
      detalle: resultado.convertido
        ? "Migue toma el pedido completo. Ojo que hubo una conversión de unidad: el vecino habló " +
          "en una unidad y el límite está en otra, así que el número no es el que escribió."
        : "Migue toma el pedido completo y genera el ticket.",
    };
  }

  if (resultado.tipo === "excede") {
    return {
      ok: true,
      tono: "alerta",
      resumen: `Se pasa: ${resultado.valorEvaluado} ${resultado.unidadEvaluada} contra un límite de ${limite.limiteValor} ${limite.limiteUnidad}`,
      detalle:
        (resultado.accion === "derivar_sin_ticket"
          ? "Migue NO toma el pedido: le explica al vecino y lo deriva. Es el único caso en que " +
            "le muestra los Puntos Verdes. "
          : "Migue toma el pedido igual, marcado como que excede el límite, y le avisa al vecino " +
            "que el retiro puede ser parcial. ") +
        `Le va a decir: «${resultado.texto}»`,
    };
  }

  // `precisar`. El motivo importa: es lo que explica por qué un límite que
  // parece claro produce una repregunta.
  const PORQUE: Record<string, string> = {
    sin_cantidad: "No dijo ninguna cantidad, así que Migue la pide.",
    cantidad_vaga: "Dijo algo impreciso y Migue prefiere pedir un número.",
    rango_ambiguo:
      "Dio un rango que cruza el límite —parte entra y parte no— así que Migue pide precisar en " +
      "lugar de elegir un extremo.",
    unidad_no_convertible:
      "La unidad que usó el vecino no se puede convertir a la del límite, así que Migue pregunta " +
      "en lugar de estimar.",
    demasiado_cerca_del_limite:
      "El valor quedó demasiado cerca del límite para decidir. Pasa sobre todo cuando hubo una " +
      "conversión de bolsas a metros cúbicos: ese factor es una aproximación, y alrededor del " +
      "límite el bot prefiere preguntar antes que equivocarse. Es la razón por la que bajar un " +
      "límite puede hacer que Migue pregunte de más sin que se vea en la tabla.",
  };

  return {
    ok: true,
    tono: "curso",
    resumen: "Migue pediría precisar",
    detalle: PORQUE[resultado.motivo] ?? "Migue volvería a preguntar la cantidad.",
  };
}
