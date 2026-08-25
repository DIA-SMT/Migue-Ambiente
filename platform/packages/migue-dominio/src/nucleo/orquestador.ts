/**
 * Orquestador: decide qué responde el bot a cada mensaje.
 *
 * Es el bucle central y NO conoce ningún canal. Recibe un mensaje canónico y
 * devuelve mensajes canónicos; quien traduce a Telegram o a WhatsApp es el
 * adaptador. Esa frontera es lo que va a permitir sumar WhatsApp sin tocar
 * nada de acá.
 *
 * Orden de resolución, y el orden es la política:
 *
 *   1. Exclusiones      un olor a gas se deriva antes de preguntar nada más
 *   2. Voto             si tocó el pulgar, se registra y se contesta eso
 *   3. Flujo activo     si hay una conversación a medias, se continúa
 *   4. Router           se clasifica y se decide
 *   5. Conocimiento     o se responde, o se admite que no se sabe
 *
 * Todas las dependencias con efectos —base de datos, Redis, modelos— entran
 * por parámetro. Eso hace que la suite pruebe el bucle completo, incluida la
 * generación de tickets, sin levantar nada.
 */
import { evaluarExclusiones, corta } from "../reglas/exclusiones.ts";
import {
  avanzarFlujo,
  cancelar,
  iniciarFlujo,
  quiereSalir,
} from "../flujos/motor.ts";
import { flujoRetiroNoHabitual } from "../flujos/retiroNoHabitual.ts";
import { flujoReclamoRecoleccion } from "../flujos/reclamoRecoleccion.ts";
import {
  flujoProgramaEduca,
  flujoProgramaSepara,
  flujoProgramaTransforma,
} from "../flujos/programas.ts";
import {
  OPCIONES_MENU,
  opcionesDeVoto,
  opcionesDeVotoTramite,
  OPCIONES_VALORACION,
  OPCIONES_VALORACION_TRAMITE,
  type SobreQue,
  resolverOpcion,
  votoDe,
  type Voto,
} from "../flujos/opciones.ts";
import { decidir, type Clasificacion } from "../ia/router.ts";
import { leerConfig, leerTexto, tieneTexto, type Catalogo } from "../datos/catalogo.ts";
import { interpolar } from "../texto.ts";
import {
  decir,
  preguntar,
  textoEfectivo,
  type MensajeEntrante,
  type MensajeSaliente,
  type OpcionRespuesta,
} from "../mensajeria.ts";
import { almacenEnMemoria, claveDeEstado, type AlmacenEstado } from "./almacen.ts";
import type { DefinicionFlujo, Efecto, EstadoFlujo, NombreFlujo } from "../flujos/tipos.ts";
import type { Respuesta } from "../conocimiento/responder.ts";
import type { OrigenRespuesta, TrazaMensaje } from "../datos/conversaciones.ts";
import type { MotivoSinRespuesta, Procedencia } from "../datos/registros.ts";
import type { ResultadoEfecto } from "../datos/efectos.ts";

/** Los cinco flujos, indexados por nombre. */
const FLUJOS: Readonly<Record<NombreFlujo, DefinicionFlujo>> = {
  retiro_no_habitual: flujoRetiroNoHabitual,
  reclamo_recoleccion: flujoReclamoRecoleccion,
  programa_educa: flujoProgramaEduca,
  programa_transforma: flujoProgramaTransforma,
  programa_separa: flujoProgramaSepara,
};

// ---------------------------------------------------------------------------
// Puertos
// ---------------------------------------------------------------------------

/** Escritura durable. Se inyecta para poder falsearla en las pruebas. */
export interface Persistencia {
  abrirConversacion(entrante: MensajeEntrante): Promise<{ id: string; esNueva: boolean }>;
  registrarEntrante(conversacionId: string, entrante: MensajeEntrante): Promise<string>;
  registrarSaliente(
    conversacionId: string,
    saliente: MensajeSaliente,
    traza: TrazaMensaje,
  ): Promise<string>;
  /**
   * El `origen_respuesta` del último saliente de la conversación, o null si no
   * hay ninguno.
   *
   * Se usa para saber si ya se mostró el menú y el vecino insistió. Se lee de la
   * BASE y no de un contador en Redis a propósito: el estado del flujo vive en
   * Redis con vencimiento, y un contador que se pierde al vencer haría que el
   * bot vuelva a mostrar el menú para siempre — que es exactamente el bucle que
   * la derivación viene a cortar. La base ya tiene el dato.
   */
  ultimoOrigenSaliente(conversacionId: string): Promise<string | null>;
  actualizarFlujo(conversacionId: string, flujo: string | null, paso: string | null): Promise<void>;
  cerrarConversacion(conversacionId: string, estado: "cerrada" | "derivada" | "abandonada"): Promise<void>;
  aplicarEfectos(efectos: readonly Efecto[], procedencia: Procedencia): Promise<ResultadoEfecto[]>;
  registrarSinRespuesta(opciones: {
    pregunta: string;
    motivo: MotivoSinRespuesta;
    conversacionId: string | null;
    mensajeId: string | null;
    confianza: number | null;
  }): Promise<unknown>;
  /**
   * Guarda el voto sobre la última respuesta.
   *
   * Los tres desenlaces son distintos y el bot los trata distinto:
   *
   *   { id: "…", yaHabiaVotado: false }  se registró ahora  -> agradecer
   *   { id: "…", yaHabiaVotado: true }   ya estaba          -> callarse
   *   { id: null, yaHabiaVotado: false } no había qué votar -> callarse
   *
   * El segundo caso es el que arregla la 029: el primer toque gana, y sin este
   * dato el bot no puede callarse en el momento correcto — o agradece de nuevo
   * en cada toque, que es el bug, o no agradece nunca.
   */
  registrarVoto(
    conversacionId: string,
    voto: Voto,
    mensajeId: string | null,
    sobre: SobreQue,
  ): Promise<{ id: string | null; yaHabiaVotado: boolean }>;
  /**
   * Intenta pegar este texto como explicación del último voto negativo.
   * Devuelve si correspondía: cuando es false, el texto era otra cosa.
   */
  comentarVoto(conversacionId: string, comentario: string): Promise<boolean>;
}

export interface Puertos {
  readonly almacen: AlmacenEstado;
  readonly obtenerCatalogo: () => Promise<Catalogo>;
  readonly clasificar: (texto: string, catalogo: Catalogo) => Promise<Clasificacion>;
  readonly responder: (consulta: string, catalogo: Catalogo) => Promise<Respuesta>;
  readonly persistencia: Persistencia;
  /** Inyectado y no `new Date()`: es lo que hace testeables los plazos. */
  readonly ahora: () => Date;
}

export interface Resultado {
  readonly salientes: readonly MensajeSaliente[];
  readonly conversacionId: string;
  readonly origenRespuesta: OrigenRespuesta;
  readonly flujoActivo: NombreFlujo | null;
  readonly efectos: readonly ResultadoEfecto[];
  /**
   * El teclado del mensaje que se acaba de tocar ya no sirve: el canal tiene
   * que quitarlo.
   *
   * Existe porque Telegram deja los botones vivos para siempre. Con la encuesta
   * eso se notaba: el vecino votaba, y podía seguir tocando 👍 👎 👍 sin que
   * nada le dijera que su voto ya estaba tomado.
   *
   * La DECISIÓN vive acá y la MANERA vive en el canal, que es la única división
   * que se sostiene: Telegram borra el teclado con `editMessageReplyMarkup`, y
   * WhatsApp no puede editar un mensaje ya enviado —ahí el bloqueo lo hace sólo
   * la base—. Un adaptador que decidiera esto por su cuenta tendría que saber
   * qué es un voto, y eso es del dominio.
   */
  readonly quitarBotones: boolean;
}

// ---------------------------------------------------------------------------
// Bucle principal
// ---------------------------------------------------------------------------

export async function procesarMensaje(
  entrante: MensajeEntrante,
  puertos: Puertos,
): Promise<Resultado> {
  const catalogo = await puertos.obtenerCatalogo();
  const conversacion = await puertos.persistencia.abrirConversacion(entrante);
  const mensajeId = await puertos.persistencia.registrarEntrante(conversacion.id, entrante);

  const texto = textoEfectivo(entrante);
  const clave = claveDeEstado(entrante.canal, entrante.canalUsuarioId);
  const procedencia: Procedencia = {
    canal: entrante.canal,
    canalUsuarioId: entrante.canalUsuarioId,
    nombreUsuario: entrante.nombreUsuario ?? null,
    conversacionId: conversacion.id,
  };

  const estadoPrevio = await puertos.almacen.leer(clave);

  // -------------------------------------------------------------------------
  // 1 · Exclusiones
  // -------------------------------------------------------------------------
  // Corren ANTES del flujo activo, y eso es deliberado: si un vecino escribe
  // «hay olor a gas» en medio de un pedido de escombros, corresponde derivarlo
  // ya, no terminar de preguntarle cuántas bolsas tiene. Por eso la regla de
  // gas tiene la prioridad más alta.
  //
  // Configurable porque tiene un costo: una palabra genérica cargada en el
  // panel podría interrumpir flujos legítimos. Si eso molesta, se apaga sin
  // deploy.
  const exclusionesEnFlujo =
    leerConfig(catalogo, "exclusiones_durante_flujo", true) === true;

  if (texto !== "" && (estadoPrevio === null || exclusionesEnFlujo)) {
    const coincidencia = evaluarExclusiones(texto, catalogo.reglasExclusion);
    if (coincidencia !== null && corta(coincidencia)) {
      await puertos.almacen.borrar(clave);
      await puertos.persistencia.cerrarConversacion(conversacion.id, "derivada");

      return await responderCon(
        [decir(coincidencia.regla.respuesta, "nada")],
        {
          conversacionId: conversacion.id,
          origenRespuesta: "exclusion",
          flujoActivo: null,
          efectos: [],
        },
        { intencion: coincidencia.regla.nombre, origenRespuesta: "exclusion" },
        puertos,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2 · ¿Votó?
  // -------------------------------------------------------------------------
  // Va ANTES del flujo activo, y no es una preferencia de orden: Telegram deja
  // los teclados en línea viejos VIVOS para siempre. El vecino puede recibir una
  // respuesta con los botones de pulgar, después arrancar un pedido de retiro, y
  // recién entonces subir en el historial y tocar el pulgar. Si esto estuviera
  // después, ese toque entraría como respuesta al paso actual del flujo —
  // «voto_util» como dirección, por ejemplo— y el vecino recibiría un «no
  // entendí» por haber usado un botón que el bot le ofreció.
  //
  // Y por eso mismo el voto NO toca el estado del flujo ni lo cierra: se
  // registra, se contesta, y la conversación a medias sigue exactamente donde
  // estaba. El siguiente mensaje la continúa.
  const reconocido = votoDe(entrante);
  if (reconocido !== null) {
    const { voto, sobre, mensajeId } = reconocido;
    // `mensajeId` viene del botón. Si es null —emoji suelto, o un teclado de
    // antes de este cambio— la base cae a su respaldo por conversación.
    const { id: idDelVoto, yaHabiaVotado } = await puertos.persistencia.registrarVoto(
      conversacion.id,
      voto,
      mensajeId,
      sobre,
    );

    // Tras un pulgar abajo se pide el detalle; tras uno arriba se agradece y se
    // corta. Los dos textos son opcionales: vaciarlos desde el panel deja el
    // voto registrándose en silencio, sin que Migue conteste nada.
    //
    // Si el voto NO se pudo guardar, no se agradece. Decirle «¡Buenísimo!» a
    // alguien cuyo voto se perdió lo confirma de algo que no pasó, y para el
    // área es una medición perdida sin ningún síntoma. Se calla y el mensaje
    // sigue su curso normal, así que al menos el vecino recibe algo útil.
    // Tras un pulgar abajo la pregunta depende de QUÉ se calificó. «¿Qué te falta
    // saber?» no tiene sentido cuando lo que estuvo difícil fue el trámite: ahí
    // lo que hace falta saber es qué paso se complicó.
    const clave_texto =
      voto === "util"
        ? "voto_gracias_util"
        : sobre === "tramite"
          ? "voto_tramite_detalle"
          : "voto_pedir_detalle";

    // Y si el voto YA ESTABA, tampoco se contesta. Esto es el arreglo de lo que
    // se vio probando: los botones de Telegram quedan vivos, el vecino tocaba
    // 👍 👎 👍 y Migue agradecía cada vez, como si cada toque contara. Ahora el
    // primer toque gana en la base (029) y el bot se calla en los siguientes.
    //
    // Callarse es mejor que decir «ya lo registré»: el teclado desaparece en el
    // mismo turno, así que un segundo toque sólo puede venir de un mensaje
    // viejo del historial, y contestarle algo a eso reabre una conversación que
    // el vecino ya cerró.
    const salientes =
      idDelVoto !== null && !yaHabiaVotado && tieneTexto(catalogo, clave_texto)
        ? [decir(leerTexto(catalogo, clave_texto), voto === "util" ? "nada" : "texto")]
        : [];

    return await responderCon(
      salientes,
      {
        conversacionId: conversacion.id,
        origenRespuesta: "flujo",
        // El teclado se quita en cuanto el voto quedó tomado —ahora o antes—.
        // Si NO se pudo tomar (`idDelVoto === null`, un botón de una charla que
        // ya no existe) se dejan los botones: quitarlos le sacaría al vecino la
        // única manera de reintentar sin decirle que algo falló.
        quitarBotones: idDelVoto !== null,
        // Se informa el flujo que sigue abierto, si había uno. Decir null acá
        // haría que el panel mostrara la conversación como charla libre cuando
        // en realidad tiene un pedido a medias.
        flujoActivo: estadoPrevio?.flujo ?? null,
        efectos: [],
      },
      { intencion: `voto_${voto}`, origenRespuesta: "flujo" },
      puertos,
    );
  }

  // -------------------------------------------------------------------------
  // 2b · ¿Este texto explica un pulgar abajo reciente?
  // -------------------------------------------------------------------------
  // Se pregunta en CADA mensaje con texto y la base decide, en vez de que el bot
  // recuerde que dejó un voto esperando. Cuesta una consulta indexada por
  // mensaje —nada, al lado de la llamada al modelo que viene después— y a cambio
  // no hay estado que se desincronice ni que se pierda si Redis se vacía.
  //
  // No se corta el procesamiento si el comentario se guardó: «yo pregunté por
  // escombros, no por poda» es a la vez la explicación del voto Y una consulta
  // nueva. Guardarla y contestar «gracias» dejaría al vecino sin respuesta por
  // segunda vez, que es exactamente lo que se estaba midiendo.
  // Dos guardas, y las dos vienen de fallas concretas:
  //
  //   `entrante.seleccion` — `texto` es en realidad `textoEfectivo()`, que
  //   devuelve `seleccion ?? texto`. Un toque de botón dejaba el ID INTERNO
  //   guardado como la explicación del vecino: «retiro_no_habitual» aparecía en
  //   la lista de conversaciones como lo que dijo que le faltaba.
  //
  //   `estadoPrevio` — con un trámite abierto, el texto es la respuesta a un
  //   paso, no una explicación. Se guardaba «Lamadrid 550» como el motivo por el
  //   que la respuesta no sirvió: además de mentir, copiaba la dirección de un
  //   vecino a una tabla que no es la del pedido, y de ahí a la LISTA de
  //   conversaciones. Y consumía el cupo de comentario, así que la explicación
  //   real, si llegaba después, ya no entraba.
  if (texto !== "" && entrante.seleccion == null && estadoPrevio === null) {
    await puertos.persistencia.comentarVoto(conversacion.id, texto);
  }

  // -------------------------------------------------------------------------
  // 3 · Flujo activo
  // -------------------------------------------------------------------------
  if (estadoPrevio !== null) {
    const definicion = FLUJOS[estadoPrevio.flujo];

    // Un flujo guardado que ya no existe en el código —por un renombre entre
    // deploys— no puede dejar al vecino atascado.
    if (definicion === undefined) {
      await puertos.almacen.borrar(clave);
      await puertos.persistencia.actualizarFlujo(conversacion.id, null, null);
    } else {
      const avance = quiereSalir(entrante)
        ? cancelar()
        : avanzarFlujo(definicion, estadoPrevio, entrante, {
            catalogo,
            ahora: puertos.ahora(),
          });

      if (avance.estado === null) {
        await puertos.almacen.borrar(clave);
        await puertos.persistencia.actualizarFlujo(conversacion.id, null, null);
      } else {
        await puertos.almacen.guardar(clave, avance.estado);
        await puertos.persistencia.actualizarFlujo(
          conversacion.id,
          avance.estado.flujo,
          avance.estado.paso,
        );
      }

      const efectos = await puertos.persistencia.aplicarEfectos(avance.efectos, procedencia);

      // ¿El trámite se COMPLETÓ? Se pregunta por los efectos y no por
      // `avance.estado === null`, que también es null cuando el vecino cancela o
      // abandona — y preguntarle «¿te resultó fácil?» a alguien que se fue a la
      // mitad es peor que no preguntar nada.
      //
      // Si se creó el ticket o la solicitud, el trámite salió. Es el único
      // momento en que la pregunta tiene sentido: el vecino acaba de pasar por
      // cinco pasos y sabe mejor que nadie si el camino fue claro.
      const seCompleto =
        avance.estado === null &&
        efectos.some(
          (e) =>
            e.ok && (e.efecto === "crear_ticket" || e.efecto === "crear_solicitud_programa"),
        );

      // Va como mensaje APARTE, igual que la del voto de respuestas: la
      // confirmación del pedido se tiene que poder reenviar o guardar sin
      // arrastrar una pregunta de cortesía.
      const encuesta: MensajeSaliente[] =
        seCompleto && tieneTexto(catalogo, "seguimiento_tras_tramite")
          ? [
              preguntar(
                leerTexto(catalogo, "seguimiento_tras_tramite"),
                OPCIONES_VALORACION_TRAMITE,
              ),
            ]
          : [];

      return await responderCon(
        [...avance.salientes, ...encuesta],
        {
          conversacionId: conversacion.id,
          origenRespuesta: "flujo",
          flujoActivo: avance.estado?.flujo ?? null,
          efectos,
        },
        { intencion: estadoPrevio.flujo, origenRespuesta: "flujo" },
        puertos,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 4 · Media sin contexto
  // -------------------------------------------------------------------------
  // Alguien manda una foto sin flujo activo y sin texto. Pasa seguido: la
  // gente saca la foto primero. Preguntarle qué necesita es mejor que mandarle
  // el mensaje de «no entendí» por algo que sí es un intento válido.
  if (texto === "" && entrante.media !== null && entrante.media !== undefined) {
    return await responderCon(
      [
        decir(
          "Recibí la foto. Contame qué necesitás y la uso para gestionarlo: " +
            "¿es un pedido de retiro, o un reclamo porque no pasó el camión?",
          "texto",
        ),
      ],
      {
        conversacionId: conversacion.id,
        origenRespuesta: "fallback",
        flujoActivo: null,
        efectos: [],
      },
      { origenRespuesta: "fallback" },
      puertos,
    );
  }

  // -------------------------------------------------------------------------
  // 5 · ¿Eligió del menú?
  //
  // Si el vecino tocó un botón del menú o escribió su número, ya dijo qué
  // quiere: llamar al clasificador para que lo adivine sería gastar una llamada
  // al modelo en algo que está dicho.
  //
  // Se hace SÓLO cuando no hay un flujo activo, que es exactamente la situación
  // en la que el bot muestra el menú. Y sólo con elecciones autocontenidas —un
  // número, el id de un botón—: buscar palabras sueltas haría que «¿cuándo pasa
  // el camión?» arrancara el flujo de reclamo, cuando es una consulta. Eso lo
  // distingue el clasificador y tiene la regla escrita.
  //
  // Lo que se asume: que un «1» sin flujo activo se refiere al menú. Puede
  // fallar si el primer mensaje de alguien es un número suelto sin haber visto
  // el menú; el costo de equivocarse es que arranca un flujo que se puede
  // cancelar escribiendo «cancelar», y el beneficio es que deja de haber un
  // bucle donde el vecino escribe el número y el bot le vuelve a mostrar el
  // menú.
  // -------------------------------------------------------------------------
  const delMenu = resolverOpcion(entrante.seleccion ?? texto, OPCIONES_MENU);

  const clasificacion: Clasificacion =
    delMenu !== null
      ? {
          intencion: delMenu as Clasificacion["intencion"],
          // Certeza total: no se adivinó nada, el vecino lo eligió.
          confianza: 1,
          modelo: "menu",
          // Es un atajo, igual que los saludos: no pasó por el modelo. Lo que
          // mide `porAtajo` es cuántos mensajes se resolvieron sin gastar una
          // llamada, y una elección del menú cuenta.
          porAtajo: true,
          tokensEntrada: 0,
          tokensSalida: 0,
          costoUsd: 0,
          latenciaMs: 0,
        }
      : await puertos.clasificar(texto, catalogo);

  const decision = decidir(clasificacion, catalogo);

  const trazaRouter: TrazaMensaje = {
    intencion: clasificacion.intencion,
    confianza: clasificacion.confianza,
    modelo: clasificacion.modelo,
    tokensEntrada: clasificacion.tokensEntrada,
    tokensSalida: clasificacion.tokensSalida,
    costoUsd: clasificacion.costoUsd,
    latenciaMs: clasificacion.latenciaMs,
  };

  switch (decision.tipo) {
    case "saludar":
      return await responderCon(
        [decir(leerTexto(catalogo, "bienvenida"), "texto")],
        { conversacionId: conversacion.id, origenRespuesta: "flujo", flujoActivo: null, efectos: [] },
        { ...trazaRouter, origenRespuesta: "flujo" },
        puertos,
      );

    case "despedir":
      await puertos.persistencia.cerrarConversacion(conversacion.id, "cerrada");
      return await responderCon(
        [decir(leerTexto(catalogo, "despedida"), "nada")],
        { conversacionId: conversacion.id, origenRespuesta: "flujo", flujoActivo: null, efectos: [] },
        { ...trazaRouter, origenRespuesta: "flujo" },
        puertos,
      );

    case "derivar": {
      // El clasificador entendió el pedido y sabe que no es de Ambiente. Acá no
      // hace falta que el vecino insista: hacerle elegir entre opciones que
      // ninguna le sirve es hacerlo perder tiempo.
      const derivado = await derivarAMigue(
        conversacion.id,
        entrante,
        texto,
        catalogo,
        trazaRouter,
        puertos,
      );
      if (derivado !== null) return derivado;

      // Sin enlace cargado no se puede derivar: cae al menú. Mejor eso que
      // decirle «escribile a Migue» sin decirle a dónde.
      return await responderCon(
        [preguntar(leerTexto(catalogo, "menu_principal"), OPCIONES_MENU)],
        { conversacionId: conversacion.id, origenRespuesta: "fallback", flujoActivo: null, efectos: [] },
        { ...trazaRouter, origenRespuesta: "fallback" },
        puertos,
      );
    }

    case "mostrar_menu": {
      // ¿Ya le mostramos el menú y volvió a escribir algo que no encaja? Si es
      // así, insistir con el menú es el bucle sin salida que este bot tenía: se
      // deriva a Migue, el asistente general del municipio.
      //
      // El menú va PRIMERO y la derivación segunda por una razón que está en los
      // datos: de los tres mensajes reales que cayeron acá, uno era `/start`,
      // otro un número de menú y el tercero un reclamo que el clasificador leyó
      // mal. Derivando al primer fallo, ese tercer vecino habría sido mandado a
      // otro número por un error NUESTRO. El menú es la red: si elige una
      // opción, era nuestro.
      const yaVioElMenu =
        (await puertos.persistencia.ultimoOrigenSaliente(conversacion.id)) === "fallback";

      if (yaVioElMenu) {
        const derivado = await derivarAMigue(
          conversacion.id,
          entrante,
          texto,
          catalogo,
          trazaRouter,
          puertos,
        );
        if (derivado !== null) return derivado;
        // Sin enlace cargado no se puede derivar: cae al menú. Mejor repetirlo
        // que decirle «escribile a Migue» sin decirle a dónde.
      }

      return await responderCon(
        [preguntar(leerTexto(catalogo, "menu_principal"), OPCIONES_MENU)],
        { conversacionId: conversacion.id, origenRespuesta: "fallback", flujoActivo: null, efectos: [] },
        { ...trazaRouter, origenRespuesta: "fallback" },
        puertos,
      );
    }

    case "iniciar_flujo": {
      const definicion = FLUJOS[decision.flujo];
      const inicio = iniciarFlujo(definicion, { catalogo, ahora: puertos.ahora() });

      // Un flujo puede resolverse en su apertura sin necesitar más mensajes.
      if (inicio.estado !== null) {
        await puertos.almacen.guardar(clave, inicio.estado);
        await puertos.persistencia.actualizarFlujo(
          conversacion.id,
          inicio.estado.flujo,
          inicio.estado.paso,
        );
      }

      const efectos = await puertos.persistencia.aplicarEfectos(inicio.efectos, procedencia);

      return await responderCon(
        inicio.salientes,
        {
          conversacionId: conversacion.id,
          origenRespuesta: "flujo",
          flujoActivo: inicio.estado?.flujo ?? null,
          efectos,
        },
        { ...trazaRouter, origenRespuesta: "flujo" },
        puertos,
      );
    }

    case "consultar_conocimiento": {
      const respuesta = await puertos.responder(texto, catalogo);

      // Lo que el bot no pudo responder se registra SIEMPRE. Es la tabla que
      // alimenta el circuito de mejora del panel: cada fila es un vecino que
      // se fue sin respuesta.
      if (respuesta.tipo === "sin_respuesta") {
        await puertos.persistencia.registrarSinRespuesta({
          pregunta: texto,
          motivo: respuesta.motivo,
          conversacionId: conversacion.id,
          mensajeId,
          confianza: respuesta.traza.confianza,
        });
      }

      const origen: OrigenRespuesta =
        respuesta.tipo === "fija"
          ? "respuesta_fija"
          : respuesta.tipo === "sintetizada"
            ? origenDeSintesis(respuesta)
            : "fallback";

      // Después de responder, preguntar si sirvió — con los dos botones de
      // pulgar, para que la respuesta quede MEDIDA y no perdida en el texto de
      // la charla. Antes esto era texto libre: el vecino contestaba «sí,
      // gracias» y nadie lo contaba, así que se sabía cuántas veces habló Migue
      // pero no si servía.
      //
      // Va como mensaje APARTE y no pegado a la respuesta: así la respuesta se
      // puede leer, copiar o reenviar sin arrastrar una pregunta de cortesía, y
      // los botones quedan junto a la pregunta y no debajo de un texto largo.
      //
      // Sólo cuando hubo respuesta de verdad. Después de un «no tengo esa
      // información» un «¿te sirvió?» es sal en la herida, y además el voto no
      // agregaría nada: esa falla ya quedó registrada en `sin_respuesta`.
      //
      // Se lee con `tieneTexto`, así que vaciarlo desde el panel apaga el voto
      // sin necesidad de un deploy.
      const cierre: MensajeSaliente[] =
        respuesta.tipo !== "sin_respuesta" && tieneTexto(catalogo, "seguimiento_tras_responder")
          ? [
              preguntar(
                leerTexto(catalogo, "seguimiento_tras_responder"),
                OPCIONES_VALORACION,
              ),
            ]
          : [];

      return await responderCon(
        [decir(respuesta.texto, "texto"), ...cierre],
        { conversacionId: conversacion.id, origenRespuesta: origen, flujoActivo: null, efectos: [] },
        {
          intencion: clasificacion.intencion,
          confianza: respuesta.traza.confianza ?? clasificacion.confianza,
          origenRespuesta: origen,
          modelo: respuesta.traza.modelo ?? clasificacion.modelo,
          // Se suman los dos: el router corre en cada mensaje y su costo tiene
          // que quedar contado, no diluido.
          tokensEntrada: clasificacion.tokensEntrada + respuesta.traza.tokensEntrada,
          tokensSalida: clasificacion.tokensSalida + respuesta.traza.tokensSalida,
          costoUsd: sumar(clasificacion.costoUsd, respuesta.traza.costoUsd),
          latenciaMs: clasificacion.latenciaMs + respuesta.traza.latenciaMs,
          fragmentosCitados:
            respuesta.tipo === "sintetizada"
              ? respuesta.coincidencias.map((c) => c.id)
              : null,
        },
        puertos,
      );
    }
  }
}

/** Si la síntesis se apoyó en una FAQ, eso es más confiable que un PDF. */
function origenDeSintesis(
  respuesta: Extract<Respuesta, { tipo: "sintetizada" }>,
): OrigenRespuesta {
  return respuesta.coincidencias.some((c) => c.origen === "faq") ? "faq" : "documentos";
}

function sumar(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Registra los mensajes salientes y devuelve el resultado.
 *
 * La traza va SÓLO en el primer mensaje. Si un turno manda tres mensajes
 * —como la apertura del flujo A— repetir tokens y costo en cada uno inflaría
 * las métricas por tres.
 */
async function responderCon(
  salientes: readonly MensajeSaliente[],
  // `quitarBotones` es opcional acá y obligatorio en `Resultado`: lo pide un
  // solo camino —el del voto— y hacérselo declarar a los otros trece sería
  // ruido que no dice nada. El default explícito de abajo es el contrato.
  resultado: Omit<Resultado, "salientes" | "quitarBotones"> & { quitarBotones?: boolean },
  traza: TrazaMensaje,
  puertos: Puertos,
): Promise<Resultado> {
  // El id del PRIMER saliente del turno, que es la respuesta. Los botones de
  // voto del segundo lo llevan pegado, así que el voto no se infiere: se sabe.
  let idDeLaRespuesta: string | null = null;
  const enviados: MensajeSaliente[] = [];

  for (const [indice, saliente] of salientes.entries()) {
    // Los salientes que siguen al primero NO llevan origen: son cortesía, no
    // respuestas. Antes se les copiaba `origenRespuesta` y eso rompió el voto —
    // la migración 022 buscaba «el último saliente con origen no nulo» para
    // saltear justamente el «¿te sirvió?», y con la columna llena en los dos el
    // último no nulo era la propia pregunta de cortesía. Sigue siendo un
    // respaldo y no el mecanismo principal, pero ahora es un respaldo correcto.
    const conBotones =
      indice === 0 || idDeLaRespuesta === null || saliente.opciones === undefined
        ? saliente
        : { ...saliente, opciones: conReferente(saliente.opciones, idDeLaRespuesta) };

    const id = await puertos.persistencia.registrarSaliente(
      resultado.conversacionId,
      conBotones,
      indice === 0 ? traza : { origenRespuesta: null },
    );

    if (indice === 0) idDeLaRespuesta = id ?? null;
    enviados.push(conBotones);
  }

  return { quitarBotones: false, ...resultado, salientes: enviados };
}

/**
 * Le pega el id del mensaje valorado a los botones de voto.
 *
 * Sólo a los de voto: el resto de las opciones —el menú, las categorías de un
 * trámite— se resuelven por su id tal cual y agregarles un sufijo rompería
 * `resolverOpcion`.
 */
function conReferente(
  opciones: readonly OpcionRespuesta[],
  mensajeId: string,
): readonly OpcionRespuesta[] {
  if (opciones.length === 0) return opciones;
  const esVotoRespuesta = opciones.every(
    (o) => o.id === "voto_util" || o.id === "voto_no_util",
  );
  if (esVotoRespuesta) return opcionesDeVoto(mensajeId);

  const esVotoTramite = opciones.every(
    (o) => o.id === "voto_tramite_util" || o.id === "voto_tramite_no_util",
  );
  if (esVotoTramite) return opcionesDeVotoTramite(mensajeId);

  return opciones;
}

/**
 * Deriva a Migue, el asistente general del municipio.
 *
 * Devuelve null si NO se puede derivar, y el llamador cae al menú. Hay dos
 * motivos para que no se pueda, y los dos son legítimos:
 *
 *   · `enlace_migue` está vacío. Arranca así a propósito: hasta que el área
 *     cargue el enlace en Reglas, decirle al vecino «escribile a Migue» sin
 *     decirle a dónde es peor que repetir el menú.
 *   · el texto `derivar_a_migue` está vacío. Es la forma de APAGAR la derivación
 *     desde el panel, sin un deploy.
 *
 * Y registra la pregunta en `sin_respuesta` con motivo `fuera_de_alcance`. Eso no
 * es para escribir una respuesta: es para que el área pueda contestar la pregunta
 * que importa —«¿esto era nuestro y lo derivamos mal?»— mirando lo que de verdad
 * pasó y no lo que suponemos.
 */
async function derivarAMigue(
  conversacionId: string,
  entrante: MensajeEntrante,
  texto: string,
  catalogo: Catalogo,
  trazaRouter: TrazaMensaje,
  puertos: Puertos,
): Promise<Resultado | null> {
  const enlace = leerConfig(catalogo, "enlace_migue", "").trim();
  if (enlace === "" || !tieneTexto(catalogo, "derivar_a_migue")) return null;

  const mensaje = interpolar(leerTexto(catalogo, "derivar_a_migue"), { migue: enlace });

  // Se registra ANTES de contestar: si la escritura falla, el vecino igual
  // recibe la derivación. Al revés perderíamos el dato Y el mensaje.
  //
  // Y se excluye el toque de botón. `texto` es en realidad `textoEfectivo()`,
  // que devuelve `seleccion ?? texto`, así que un botón dejaba el ID INTERNO
  // guardado como la pregunta del vecino: la lista se habría llenado de
  // «reclamo_recoleccion» en lugar de preguntas. Es el mismo error que ya se
  // cometió con el comentario del voto, y lo encontró la prueba de esta función.
  if (texto.trim() !== "" && entrante.seleccion == null) {
    await puertos.persistencia.registrarSinRespuesta({
      conversacionId,
      pregunta: texto,
      motivo: "fuera_de_alcance",
      // No hay un mensaje al que colgarla —la derivación no cita nada— ni una
      // confianza del buscador, porque no se llegó a buscar.
      mensajeId: null,
      confianza: null,
    });
  }

  return await responderCon(
    [decir(mensaje, "nada")],
    {
      conversacionId,
      origenRespuesta: "exclusion",
      flujoActivo: null,
      efectos: [],
    },
    { ...trazaRouter, origenRespuesta: "exclusion", intencion: "derivada_a_migue" },
    puertos,
  );
}

// ---------------------------------------------------------------------------
// Utilidades para pruebas
// ---------------------------------------------------------------------------

/** Almacén en memoria, reexportado para armar puertos de prueba. */
export { almacenEnMemoria, claveDeEstado };

/** Los flujos registrados, para inspección. */
export function flujosRegistrados(): readonly NombreFlujo[] {
  return Object.keys(FLUJOS) as NombreFlujo[];
}

export type { EstadoFlujo };
