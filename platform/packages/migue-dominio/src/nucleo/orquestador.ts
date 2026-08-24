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
 *   2. Flujo activo     si hay una conversación a medias, se continúa
 *   3. Router           se clasifica y se decide
 *   4. Conocimiento     o se responde, o se admite que no se sabe
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
import { OPCIONES_MENU, resolverOpcion } from "../flujos/opciones.ts";
import { decidir, type Clasificacion } from "../ia/router.ts";
import { leerConfig, leerTexto, tieneTexto, type Catalogo } from "../datos/catalogo.ts";
import {
  decir,
  preguntar,
  textoEfectivo,
  type MensajeEntrante,
  type MensajeSaliente,
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
  ): Promise<void>;
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
  // 2 · Flujo activo
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

      return await responderCon(
        avance.salientes,
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
  // 3 · Media sin contexto
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
  // 4 · ¿Eligió del menú?
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

    case "mostrar_menu":
      // Con opciones de verdad y no como texto suelto. Dos motivos: en Telegram
      // aparecen como botones, y si el vecino igual escribe el número, el
      // resolutor lo entiende. Antes el menú era texto numerado y contestar «1»
      // no hacía nada: el clasificador no reconocía el número y el bot volvía a
      // mostrar el menú. El vecino repetía el número creyendo que no llegaba.
      return await responderCon(
        [preguntar(leerTexto(catalogo, "menu_principal"), OPCIONES_MENU)],
        { conversacionId: conversacion.id, origenRespuesta: "fallback", flujoActivo: null, efectos: [] },
        { ...trazaRouter, origenRespuesta: "fallback" },
        puertos,
      );

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

      // Después de responder, preguntar si sirvió. Va como mensaje APARTE y no
      // pegado a la respuesta: así la respuesta se puede leer, copiar o reenviar
      // sin arrastrar una pregunta de cortesía.
      //
      // Sólo cuando hubo respuesta de verdad. Después de un «no tengo esa
      // información» un «¿te sirvió?» es sal en la herida, y ese texto ya dice
      // qué hacer.
      //
      // Se lee con `tieneTexto`, así que vaciarlo desde el panel apaga el
      // seguimiento sin necesidad de un deploy.
      const cierre: MensajeSaliente[] =
        respuesta.tipo !== "sin_respuesta" && tieneTexto(catalogo, "seguimiento_tras_responder")
          ? [decir(leerTexto(catalogo, "seguimiento_tras_responder"), "texto")]
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
  resultado: Omit<Resultado, "salientes">,
  traza: TrazaMensaje,
  puertos: Puertos,
): Promise<Resultado> {
  for (const [indice, saliente] of salientes.entries()) {
    await puertos.persistencia.registrarSaliente(
      resultado.conversacionId,
      saliente,
      indice === 0 ? traza : { origenRespuesta: traza.origenRespuesta ?? null },
    );
  }
  return { ...resultado, salientes };
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
