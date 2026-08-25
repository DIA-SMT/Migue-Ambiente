/**
 * Verifica en producción lo que la 022 agrega: el voto del vecino.
 *
 *   node --env-file=../../.env.local herramientas/verificar-voto.mjs
 *
 * Corre con `service_role`, que es la misma clave con la que corre el BOT. Eso
 * es lo que hace útil este script y no sólo un chequeo de esquema: acá se puede
 * ejercitar el circuito completo del voto exactamente como lo va a ejercitar
 * Migue, sobre una conversación de prueba que se borra al final.
 *
 * Lo que NO prueba es el RLS del panel —para eso hace falta una sesión— y eso lo
 * cubre el bloque N del arnés, con sus tres sabotajes comprobados.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let fallas = 0;
const mal = (m) => {
  console.log(`  MAL  ${m}`);
  fallas++;
};
const bien = (m) => console.log(`  ok   ${m}`);

const USUARIO_PRUEBA = `verificacion-voto-${process.pid}`;
let conversacionId = null;

try {
  /* --- 1 · La vista de conversaciones y su contrato --------------------- */

  const COLUMNAS = [
    "id", "canal", "nombre_usuario", "estado", "flujo_activo",
    "cantidad_mensajes", "iniciada_en", "ultima_actividad_en", "votos_utiles",
    "votos_no_utiles", "ultimo_comentario", "primer_mensaje",
    "preguntas_pendientes", "preguntas_falladas",
  ];

  const { data: vista, error: eVista } = await supabase
    .from("v_conversaciones")
    .select("*")
    .order("ultima_actividad_en", { ascending: false })
    .limit(200);

  if (eVista) {
    mal(`v_conversaciones: ${eVista.message}`);
  } else {
    bien(`v_conversaciones responde — ${vista.length} conversación(es) reales`);
    let faltantes = 0;
    for (const col of COLUMNAS) {
      const { error } = await supabase.from("v_conversaciones").select(col).limit(1);
      if (error) {
        mal(`falta la columna ${col}: ${error.message}`);
        faltantes++;
      }
    }
    if (faltantes === 0) bien(`las ${COLUMNAS.length} columnas que lee el panel existen`);
  }

  /* --- 2 · El circuito completo, como lo hace el bot -------------------- */

  const { data: conv, error: eConv } = await supabase
    .from("conversaciones")
    .insert({ canal: "telegram", canal_usuario_id: USUARIO_PRUEBA, nombre_usuario: "Verificación" })
    .select("id")
    .single();

  if (eConv) throw new Error(`no pude sembrar la conversación: ${eConv.message}`);
  conversacionId = conv.id;

  await supabase.from("mensajes").insert({
    conversacion_id: conversacionId,
    direccion: "entrante",
    texto: "cuando pasa el camion de poda",
  });

  // El turno del bot son DOS salientes: la respuesta con traza, y después el
  // «¿te sirvió?» sin traza. Reproducirlo es el punto de esta prueba.
  const { data: respuesta } = await supabase
    .from("mensajes")
    .insert({
      conversacion_id: conversacionId,
      direccion: "saliente",
      texto: "Los residuos verdes se retiran los martes y viernes.",
      origen_respuesta: "faq",
      intencion: "consulta_libre",
    })
    .select("id")
    .single();

  // OJO CON ESTA FILA. La primera versión de este script la sembraba SIN
  // `origen_respuesta`, y por eso decía «ok: el voto se colgó de la respuesta».
  // Era un OK falso: el orquestador nunca produce ese estado. Le copiaba
  // `origenRespuesta` a TODOS los salientes del turno, así que en producción la
  // cortesía tenía la columna llena, el subselect de `registrar_voto` la elegía
  // a ella, y el 100% de los votos quedaba colgado de la pregunta de cortesía.
  //
  // O sea: el script verificaba un escenario que el bot no podía generar. Ahora
  // se siembra igual que en producción DESPUÉS del arreglo —cortesía con la
  // columna en null, que es lo que `responderCon` escribe— y además el caso de
  // abajo prueba el camino principal, que es pasar el id explícito.
  const { data: cortesia } = await supabase
    .from("mensajes")
    .insert({
      conversacion_id: conversacionId,
      direccion: "saliente",
      texto: "¿Te sirvió esta respuesta?",
      origen_respuesta: null,
    })
    .select("id")
    .single();

  // 2a · El voto tiene que colgarse de la RESPUESTA, no del «¿te sirvió?»,
  //      aunque ese sea el último saliente. Es el error más fácil de cometer y
  //      el que haría que el panel muestre un pulgar abajo sobre un texto que
  //      dice «¿te sirvió?».
  // Desde la 029 devuelve `{ id, ya_habia_votado }` y no un uuid: el bot
  // necesita distinguir «se registró ahora» de «ya estaba» para saber si
  // agradecer o callarse.
  const { data: primerVoto, error: eVoto } = await supabase.rpc("registrar_voto", {
    p_conversacion_id: conversacionId,
    p_voto: "no_util",
  });
  const votoId = primerVoto?.id ?? null;

  if (eVoto) {
    mal(`registrar_voto falló: ${eVoto.message}`);
  } else if (!votoId) {
    mal("registrar_voto devolvió null sobre una conversación con respuesta");
  } else if (primerVoto.ya_habia_votado !== false) {
    mal("el PRIMER voto vino marcado como repetido: el bot no agradecería nunca");
  } else {
    const { data: fila } = await supabase
      .from("valoraciones")
      .select("mensaje_id, voto")
      .eq("id", votoId)
      .single();

    if (fila?.mensaje_id === cortesia.id) {
      mal("el voto quedó colgado del «¿te sirvió?» en vez de la respuesta");
    } else if (fila?.mensaje_id !== respuesta.id) {
      mal("el voto quedó colgado de un mensaje inesperado");
    } else {
      bien("el voto se colgó de la respuesta, no del «¿te sirvió?»");
    }
  }

  // 2b · Tocar dos veces no cuenta doble.
  // Y ESTE CHEQUEO NO ALCANZABA. Contaba filas, y filas duplicadas nunca hubo:
  // el `on conflict do update` de antes cambiaba el voto y devolvía un id, así
  // que el bot volvía a agradecer en cada toque. Contaba la tabla mientras el
  // problema estaba en la conversación. Ahora se exige el aviso.
  const { data: repetido } = await supabase.rpc("registrar_voto", {
    p_conversacion_id: conversacionId,
    p_voto: "no_util",
  });
  const { count } = await supabase
    .from("valoraciones")
    .select("id", { count: "exact", head: true })
    .eq("conversacion_id", conversacionId);
  if (count !== 1) mal(`dos toques del mismo botón crearon ${count} filas`);
  else if (repetido?.ya_habia_votado !== true)
    mal("el segundo toque no vino marcado: el bot volvería a agradecer");
  else bien("el segundo toque no duplica y viene marcado como repetido");

  // 2c · El comentario se pega, y el segundo texto ya no lo sobrescribe. Esto
  //      último es lo que permite que el bot llame a la función en CADA mensaje
  //      sin destruir lo guardado.
  const { data: pego } = await supabase.rpc("comentar_voto", {
    p_conversacion_id: conversacionId,
    p_comentario: "yo pregunte por escombros no por poda",
  });
  if (pego !== true) mal("no se pudo pegar el comentario al voto");
  else bien("el comentario se pegó al voto negativo");

  const { data: pego2 } = await supabase.rpc("comentar_voto", {
    p_conversacion_id: conversacionId,
    p_comentario: "una consulta nueva que no tiene nada que ver",
  });
  if (pego2 !== false) mal("un segundo texto sobrescribió el comentario que ya estaba");
  else bien("el segundo texto NO sobrescribe: el bot puede preguntar en cada mensaje");

  // 2d · La vista resume el voto y trae el primer mensaje del vecino.
  const { data: resumen } = await supabase
    .from("v_conversaciones")
    .select("votos_utiles, votos_no_utiles, ultimo_comentario, primer_mensaje")
    .eq("id", conversacionId)
    .single();

  if (resumen?.votos_no_utiles !== 1) mal(`la vista contó ${resumen?.votos_no_utiles} negativos`);
  else if (resumen?.primer_mensaje !== "cuando pasa el camion de poda")
    mal(`la vista trae mal el primer mensaje: ${resumen?.primer_mensaje}`);
  else if (!resumen?.ultimo_comentario?.includes("escombros"))
    mal("la vista no trae el comentario del vecino");
  else bien("la vista resume el voto, el comentario y el primer mensaje");

  // 2e · La transcripción pega el voto a la burbuja correcta.
  const { data: trans, error: eTrans } = await supabase.rpc("transcripcion", {
    p_conversacion_id: conversacionId,
  });
  if (eTrans) {
    mal(`transcripcion falló: ${eTrans.message}`);
  } else {
    const conVoto = (trans ?? []).filter((m) => m.voto !== null);
    if (conVoto.length !== 1) mal(`la transcripción pegó el voto a ${conVoto.length} mensajes`);
    else if (!conVoto[0].texto.startsWith("Los residuos verdes"))
      mal(`el voto quedó pegado a «${conVoto[0].texto}»`);
    else bien(`la transcripción trae ${trans.length} mensajes con el voto en el correcto`);
  }

  // 2f · EL VOTO NO SE CAMBIA. Este chequeo afirmaba lo contrario hasta la 029:
  //      probaba que cambiar de pulgar limpiara el comentario. Probando el bot
  //      se vio por qué estaba mal — se podía votar 👍 👎 👍 👎 y Migue agradecía
  //      cada vez, como si cada toque contara.
  //
  //      El dato que le sirve al área es la primera reacción. El que tocó por
  //      error lo puede decir en el comentario, que es lo que el área lee.
  const { data: arrepentido } = await supabase.rpc("registrar_voto", {
    p_conversacion_id: conversacionId,
    p_voto: "util",
  });
  const { data: tras } = await supabase
    .from("valoraciones")
    .select("voto, comentario")
    .eq("conversacion_id", conversacionId)
    .single();
  if (arrepentido?.ya_habia_votado !== true)
    mal("el cambio de opinión no vino marcado como repetido");
  else if (tras?.voto !== "no_util")
    mal(`el voto se cambió a «${tras?.voto}»: el primer toque tenía que ganar`);
  else if (!tras?.comentario?.includes("escombros"))
    mal(`se perdió el comentario del vecino: ${tras?.comentario}`);
  else bien("el primer toque gana y el comentario queda donde estaba");

  /* --- 3 · Los textos que el bot va a usar ------------------------------ */

  const { data: textos } = await supabase
    .from("textos_bot")
    .select("clave, texto, opcional")
    .in("clave", ["seguimiento_tras_responder", "voto_gracias_util", "voto_pedir_detalle"]);

  if ((textos ?? []).length !== 3) {
    mal(`faltan textos del voto: hay ${(textos ?? []).length} de 3`);
  } else if (textos.some((t) => !t.opcional)) {
    // Si no son opcionales, `tieneTexto` no puede apagarlos vaciándolos y el
    // área pierde la única forma de desactivar el voto sin un deploy.
    mal("algún texto del voto no está marcado opcional: no se podría apagar desde el panel");
  } else {
    bien("los tres textos del voto están cargados y son opcionales");
    for (const t of textos) console.log(`         ${t.clave}: ${JSON.stringify(t.texto)}`);
  }
} catch (e) {
  mal(`se cortó: ${e.message}`);
} finally {
  /* --- Limpieza. `on delete cascade` se lleva mensajes y valoraciones. --- */
  if (conversacionId) {
    await supabase.from("conversaciones").delete().eq("id", conversacionId);
    const { count } = await supabase
      .from("conversaciones")
      .select("id", { count: "exact", head: true })
      .eq("canal_usuario_id", USUARIO_PRUEBA);
    if (count !== 0) mal(`quedó basura de la prueba: ${count} conversación(es)`);
    else bien("la conversación de prueba y todo lo suyo quedaron borrados");
  }
}

/* --- El camino principal: el id explícito, que es lo que manda el bot ---- */
//
// Desde el arreglo, los botones llevan `voto_util:<mensaje_id>` y el bot pasa
// ese id a `registrar_voto`. Este bloque prueba que el id explícito GANA sobre
// cualquier inferencia: se siembra una cortesía posterior CON origen no nulo
// —el peor caso, el que rompía todo— y el voto tiene que quedar igual en la
// respuesta.
{
  const { data: c2 } = await supabase
    .from("conversaciones")
    .insert({ canal: "telegram", canal_usuario_id: `${USUARIO_PRUEBA}-b`, nombre_usuario: "Verificación" })
    .select("id")
    .single();
  const conv = c2.id;

  const { data: resp } = await supabase
    .from("mensajes")
    .insert({
      conversacion_id: conv,
      direccion: "saliente",
      texto: "La poda se retira los martes.",
      origen_respuesta: "faq",
    })
    .select("id")
    .single();

  // Una cortesía POSTERIOR con la columna llena: es exactamente el estado que
  // hacía fallar la inferencia.
  await supabase.from("mensajes").insert({
    conversacion_id: conv,
    direccion: "saliente",
    texto: "¿Te sirvió esta respuesta?",
    origen_respuesta: "faq",
  });

  const { data: conId, error } = await supabase.rpc("registrar_voto", {
    p_conversacion_id: conv,
    p_voto: "no_util",
    p_mensaje_id: resp.id,
  });
  const idVoto = conId?.id ?? null;

  if (error) {
    mal(`registrar_voto con id explícito falló: ${error.message}`);
  } else {
    const { data: v } = await supabase
      .from("valoraciones")
      .select("mensaje_id")
      .eq("id", idVoto)
      .single();
    if (v?.mensaje_id !== resp.id) {
      mal("el id explícito no ganó: el voto quedó colgado de otro mensaje");
    } else {
      bien("el id explícito gana sobre la inferencia, incluso con una cortesía posterior");
    }

    // Y el doble toque sobre el MISMO mensaje no duplica ni cambia nada. Con la
    // inferencia esto insertaba una segunda fila, porque el mensaje que resolvía
    // cambiaba entre un toque y el siguiente.
    const { data: segundo } = await supabase.rpc("registrar_voto", {
      p_conversacion_id: conv,
      p_voto: "util",
      p_mensaje_id: resp.id,
    });
    const { count } = await supabase
      .from("valoraciones")
      .select("id", { count: "exact", head: true })
      .eq("mensaje_id", resp.id);
    const { data: quedo } = await supabase
      .from("valoraciones")
      .select("voto")
      .eq("mensaje_id", resp.id)
      .single();
    if (count !== 1) mal(`el doble toque dejó ${count} filas`);
    else if (segundo?.ya_habia_votado !== true) mal("el doble toque no vino marcado");
    else if (quedo?.voto !== "no_util") mal(`el doble toque cambió el voto a «${quedo?.voto}»`);
    else bien("dos toques sobre el mismo mensaje dejan un solo voto, el primero");
  }

  await supabase.from("conversaciones").delete().eq("id", conv);
}

/* --- La 023: lo que la vista NO tiene que exponer, y el número que baja --- */

{
  // `canal_usuario_id` en WhatsApp es el teléfono del vecino. Que la columna NO
  // exista en la vista es la protección: RLS es por FILA y no por COLUMNA, así
  // que lo único que evita que se lea es no seleccionarla. Se comprueba pidiéndola
  // y esperando un error 42703.
  const { error } = await supabase.from("v_conversaciones").select("canal_usuario_id").limit(1);
  if (!error) {
    mal("v_conversaciones sigue exponiendo canal_usuario_id: en WhatsApp es el teléfono del vecino");
  } else if (/does not exist|42703|column/i.test(error.message)) {
    bien("v_conversaciones ya no expone canal_usuario_id");
  } else {
    mal(`no pude comprobar canal_usuario_id: ${error.message}`);
  }
}

{
  // El número accionable tiene que BAJAR cuando la pregunta se resuelve. Antes
  // contaba todas las filas de `sin_respuesta` sin mirar el estado, así que era
  // monótono creciente: escribir la respuesta no lo movía.
  const { data: c3 } = await supabase
    .from("conversaciones")
    .insert({ canal: "telegram", canal_usuario_id: `${USUARIO_PRUEBA}-c`, nombre_usuario: "Verificación" })
    .select("id")
    .single();

  const { data: sr } = await supabase
    .from("sin_respuesta")
    .insert({ conversacion_id: c3.id, pregunta: "__prueba 023 pendiente", motivo: "sin_coincidencia" })
    .select("id")
    .single();

  const leer = async () => {
    const { data } = await supabase
      .from("v_conversaciones")
      .select("preguntas_pendientes, preguntas_falladas")
      .eq("id", c3.id)
      .single();
    return data;
  };

  const antes = await leer();
  if (antes?.preguntas_pendientes !== 1 || antes?.preguntas_falladas !== 1) {
    mal(`con una pregunta pendiente esperaba 1 y 1, dio ${JSON.stringify(antes)}`);
  } else {
    // Se resuelve, como lo haría el panel.
    await supabase.from("sin_respuesta").update({ estado: "resuelta" }).eq("id", sr.id);
    const despues = await leer();

    if (despues?.preguntas_pendientes !== 0) {
      mal(
        `al resolverla, preguntas_pendientes quedó en ${despues?.preguntas_pendientes}: ` +
          `el número no baja y «donde algo falló» nunca se vacía`,
      );
    } else if (despues?.preguntas_falladas !== 1) {
      mal(`se perdió la historia: preguntas_falladas quedó en ${despues?.preguntas_falladas}`);
    } else {
      bien("al resolver una pregunta, la pendiente baja a 0 y la historia queda en 1");
    }
  }

  // Se borra la fila de `sin_respuesta` EXPLÍCITAMENTE. Su FK a
  // `conversaciones` es `on delete set null`, así que borrar la conversación no
  // se la lleva: la deja huérfana. La primera corrida de esto dejó una fila
  // «__prueba 023 pendiente» en producción, y habría aparecido en Métricas como
  // una pregunta real que un vecino hizo.
  await supabase.from("sin_respuesta").delete().eq("id", sr.id);
  await supabase.from("conversaciones").delete().eq("id", c3.id);
}

console.log();
console.log(fallas === 0 ? "TODO OK" : `${fallas} PROBLEMA(S)`);
process.exit(fallas === 0 ? 0 : 1);
