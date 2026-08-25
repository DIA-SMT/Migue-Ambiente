/**
 * Verifica en PRODUCCIÓN lo que agrega la 028: la encuesta al terminar un
 * trámite, y que sea una medición SEPARADA de la del voto a una respuesta.
 *
 *   node --env-file=../../.env.local --env-file=.env.local \
 *        herramientas/verificar-encuesta.mjs
 *
 * Corre con `service_role`, la misma clave con la que corre el bot: eso permite
 * ejercitar el circuito exactamente como lo va a ejercitar Migue. Y además abre
 * un segundo cliente con la clave ANON —la del panel— para comprobar que el
 * panel NO puede tocar el voto de un vecino.
 *
 * Lo que NO prueba es el RLS con una sesión del padrón; eso lo cubre el bloque N
 * del arnés, que corre contra una base local y tiene sabotajes comprobados.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL.trim();
const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY.trim(), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.trim(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

let fallas = 0;
const mal = (m) => {
  console.log(`  MAL  ${m}`);
  fallas++;
};
const bien = (m) => console.log(`  ok   ${m}`);

const USUARIO_PRUEBA = `verificacion-encuesta-${process.pid}`;
let conversacionId = null;

try {
  /* --- 1 · El contrato de la vista, columna por columna ----------------- */
  // El panel hace `select("*")` y tipa el resultado. Si falta una columna, el
  // panel no explota: muestra `undefined` y el operador ve una conversación sin
  // votos. Por eso se comprueba una por una.
  const COLUMNAS = [
    "id", "canal", "nombre_usuario", "estado", "flujo_activo",
    "cantidad_mensajes", "iniciada_en", "ultima_actividad_en",
    "votos_utiles", "votos_no_utiles",
    "votos_respuesta_mala", "votos_tramite_dificil",
    "ultimo_comentario", "primer_mensaje",
    "preguntas_pendientes", "preguntas_falladas",
  ];
  let faltantes = 0;
  for (const col of COLUMNAS) {
    const { error } = await supabase.from("v_conversaciones").select(col).limit(1);
    if (error) {
      mal(`falta la columna ${col} en v_conversaciones: ${error.message}`);
      faltantes++;
    }
  }
  if (faltantes === 0) bien(`las ${COLUMNAS.length} columnas que lee el panel existen`);

  // Y que `canal_usuario_id` siga FUERA. En WhatsApp es el teléfono del vecino.
  const { error: eFuga } = await supabase
    .from("v_conversaciones").select("canal_usuario_id").limit(1);
  if (!eFuga) mal("la vista volvió a exponer canal_usuario_id (el teléfono del vecino)");
  else bien("la vista no expone canal_usuario_id");

  /* --- 2 · Los textos de las dos encuestas ------------------------------ */
  const { data: textos, error: eTextos } = await supabase
    .from("textos_bot")
    .select("clave, texto, opcional")
    .in("clave", [
      "seguimiento_tras_responder", "voto_gracias_util", "voto_pedir_detalle",
      "seguimiento_tras_tramite", "voto_tramite_detalle",
    ]);

  if (eTextos) {
    mal(`no pude leer textos_bot: ${eTextos.message}`);
  } else if (textos.length !== 5) {
    mal(`hay ${textos.length} de los 5 textos del voto: ${textos.map((t) => t.clave).join(", ")}`);
  } else {
    const noOpcional = textos.filter((t) => !t.opcional).map((t) => t.clave);
    if (noOpcional.length > 0) {
      mal(`estos no son opcionales, así que no se pueden vaciar: ${noOpcional.join(", ")}`);
    } else {
      bien("los 5 textos del voto están cargados y son opcionales (se pueden apagar)");
    }
    // Si el texto de la encuesta del trámite está vacío, la encuesta está
    // APAGADA. Es una puerta legítima del panel, pero conviene saberlo ahora y
    // no cuando el usuario pruebe el bot y no vea nada.
    const tramite = textos.find((t) => t.clave === "seguimiento_tras_tramite");
    if (!tramite.texto || tramite.texto.trim() === "") {
      mal("seguimiento_tras_tramite está VACÍO: la encuesta del trámite está apagada");
    } else {
      bien(`la encuesta del trámite dice: «${tramite.texto}»`);
    }
  }

  /* --- 3 · El circuito, igual que lo hace el bot ------------------------ */
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
    texto: "necesito que retiren ramas",
  });

  // Una respuesta (se vota como 'respuesta') y una confirmación de trámite (se
  // vota como 'tramite'). Las dos con traza, que es lo que escribe el bot.
  const { data: respuesta } = await supabase.from("mensajes").insert({
    conversacion_id: conversacionId,
    direccion: "saliente",
    texto: "Los residuos verdes se retiran los martes y viernes.",
    origen_respuesta: "faq",
    intencion: "consulta_libre",
  }).select("id").single();

  const { data: cierre } = await supabase.from("mensajes").insert({
    conversacion_id: conversacionId,
    direccion: "saliente",
    texto: "Solicitud registrada. Número AMB-999.",
    origen_respuesta: "flujo",
  }).select("id").single();

  // 3a · El voto de la RESPUESTA, con el id explícito (el camino del botón) y
  //      SIN el cuarto argumento.
  //
  //      ESTE es el chequeo de compatibilidad que importa: el bot que está
  //      desplegado ahora mismo llama con tres argumentos. Si el default no
  //      fuera 'respuesta', la 028 habría reclasificado en silencio todos los
  //      votos que ya venían andando.
  const { data: r1, error: e1 } = await supabase.rpc("registrar_voto", {
    p_conversacion_id: conversacionId,
    p_voto: "no_util",
    p_mensaje_id: respuesta.id,
  });
  const v1 = r1?.id ?? null;
  if (e1) mal(`registrar_voto de 3 argumentos falló: ${e1.message}`);
  else if (!v1) mal("registrar_voto devolvió null sobre un mensaje que existe");
  else {
    const { data: fila } = await supabase
      .from("valoraciones").select("sobre").eq("id", v1).single();
    if (fila?.sobre !== "respuesta") {
      mal(`sin el 4º argumento, la columna quedó en «${fila?.sobre}» en vez de respuesta`);
    } else {
      bien("sin el 4º argumento el voto sigue siendo de 'respuesta' (el bot viejo no se rompe)");
    }
  }

  // 3b · El voto del TRÁMITE. Es la llamada nueva que hace el bot.
  const { data: r2, error: e2 } = await supabase.rpc("registrar_voto", {
    p_conversacion_id: conversacionId,
    p_voto: "no_util",
    p_mensaje_id: cierre.id,
    p_sobre: "tramite",
  });
  const v2 = r2?.id ?? null;
  if (e2) {
    mal(`registrar_voto con p_sobre falló: ${e2.message} <-- el bot no puede votar el trámite`);
  } else if (!v2) {
    mal("el voto del trámite devolvió null");
  } else {
    const { data: fila } = await supabase
      .from("valoraciones").select("sobre").eq("id", v2).single();
    if (fila?.sobre !== "tramite") mal(`el voto del trámite quedó como «${fila?.sobre}»`);
    else bien("el voto del trámite se guarda como 'tramite'");
  }

  // 3c · Y la vista los SEPARA. Sin esto el panel manda al área a reescribir una
  //      respuesta que estaba bien, porque el vecino en realidad se quejó del
  //      camino del trámite.
  const { data: r } = await supabase
    .from("v_conversaciones")
    .select("votos_no_utiles, votos_respuesta_mala, votos_tramite_dificil")
    .eq("id", conversacionId)
    .single();

  if (r?.votos_no_utiles !== 2) mal(`la vista contó ${r?.votos_no_utiles} pulgares abajo, esperaba 2`);
  else if (r?.votos_respuesta_mala !== 1) mal(`respuestas malas: ${r?.votos_respuesta_mala}, esperaba 1`);
  else if (r?.votos_tramite_dificil !== 1) mal(`trámites difíciles: ${r?.votos_tramite_dificil}, esperaba 1`);
  else bien("la vista separa 1 respuesta mala de 1 trámite difícil (2 pulgares abajo en total)");

  // 3d · Un valor inventado en `sobre` se rechaza. Si entrara basura, la
  //      separación de arriba deja de valer y el panel muestra números que no
  //      suman.
  const { error: eBasura } = await supabase.rpc("registrar_voto", {
    p_conversacion_id: conversacionId,
    p_voto: "util",
    p_mensaje_id: cierre.id,
    p_sobre: "mas_o_menos",
  });
  if (!eBasura) mal("aceptó un valor inventado en la columna sobre");
  else if (!/sobre invalido/i.test(eBasura.message)) {
    mal(`lo rechazó, pero con otro error: ${eBasura.message}`);
  } else {
    bien("un valor inventado en la columna sobre se rechaza");
  }

  // 3e · El comentario del trámite se pega al voto del trámite.
  const { data: pego } = await supabase.rpc("comentar_voto", {
    p_conversacion_id: conversacionId,
    p_comentario: "me pidio la foto dos veces",
  });
  if (pego !== true) mal("no se pudo pegar el comentario al voto del trámite");
  else {
    const { data: fila } = await supabase
      .from("valoraciones").select("sobre, comentario").eq("id", v2).single();
    if (fila?.comentario !== "me pidio la foto dos veces") {
      mal("el comentario del trámite se pegó a otro voto");
    } else {
      bien("el comentario se pega al voto más reciente, que es el del trámite");
    }
  }

  /* --- 3f · El bloqueo de la 029, sobre las dos encuestas --------------- */
  // El arreglo fácil y equivocado sería «un voto por conversación». Rompería la
  // encuesta del trámite: acá hay DOS votos en la misma charla, uno de la
  // respuesta y uno del trámite, y los dos tienen que haber entrado.
  const { count: cuantos } = await supabase
    .from("valoraciones")
    .select("id", { count: "exact", head: true })
    .eq("conversacion_id", conversacionId);
  if (cuantos !== 2) mal(`el bloqueo dejó ${cuantos} votos en vez de 2`);
  else bien("el bloqueo es por mensaje, no por conversación: entraron los dos votos");

  // Y un segundo toque sobre el voto del trámite no cambia nada ni contesta.
  const { data: reToque } = await supabase.rpc("registrar_voto", {
    p_conversacion_id: conversacionId,
    p_voto: "util",
    p_mensaje_id: cierre.id,
    p_sobre: "tramite",
  });
  const { data: siguePeor } = await supabase
    .from("valoraciones").select("voto").eq("id", v2).single();
  if (reToque?.ya_habia_votado !== true) mal("el segundo toque del trámite no vino marcado");
  else if (siguePeor?.voto !== "no_util") mal("el segundo toque cambió el voto del trámite");
  else bien("el segundo toque del trámite no cambia nada y viene marcado");

  /* --- 4 · Y el panel no puede tocar nada de esto ----------------------- */
  // `registrar_voto` está revocada a anon/authenticated a propósito: el voto es
  // del vecino. Que alguien del municipio lo pueda escribir destruiría el único
  // dato honesto de la tabla.
  const { error: eAnon } = await anon.rpc("registrar_voto", {
    p_conversacion_id: conversacionId,
    p_voto: "util",
    p_mensaje_id: cierre.id,
    p_sobre: "tramite",
  });
  if (!eAnon) mal("la clave ANON pudo registrar un voto: la función quedó abierta");
  else bien(`la clave ANON no puede votar (${eAnon.code ?? eAnon.message})`);

  // Y no puede cambiar uno que ya está. Sin sesión, RLS no le deja ver ninguna
  // fila, así que el UPDATE "no falla": simplemente no toca nada. Lo que hay que
  // comprobar es el EFECTO, no el error.
  await anon.from("valoraciones").update({ voto: "util" }).eq("conversacion_id", conversacionId);
  const { data: sigue } = await supabase
    .from("valoraciones").select("voto").eq("id", v2).single();
  if (sigue?.voto !== "no_util") mal("la clave ANON cambió el voto de un vecino");
  else bien("la clave ANON no cambia el voto de un vecino");

  // Vale aclarar qué prueba y qué no este último chequeo: la RPC está revocada y
  // el UPDATE directo no pasa el RLS, así que el voto está cerrado por los dos
  // lados. El bloqueo del segundo toque (029) es otra cosa —protege del propio
  // vecino, no del panel— y se prueba arriba.
} finally {
  if (conversacionId) {
    await supabase.from("conversaciones").delete().eq("id", conversacionId);
    console.log("  --   limpié la conversación de prueba");
  }
}

console.log(fallas === 0 ? "\nTODO BIEN\n" : `\n${fallas} FALLA(S)\n`);
process.exit(fallas === 0 ? 0 : 1);
