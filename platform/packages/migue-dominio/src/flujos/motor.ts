/**
 * Motor de flujos: aplica una transición y devuelve el estado nuevo.
 *
 * No conoce ningún flujo en particular. Los flujos son datos que se le pasan,
 * así que agregar uno nuevo no implica tocar el motor.
 */
import { decir, type MensajeEntrante, type MensajeSaliente } from "../mensajeria.ts";
import { nombreDelArea } from "../datos/catalogo.ts";
import { resolverOpcion, type OpcionElegible } from "./opciones.ts";
import type {
  ContextoFlujo,
  DatosFlujo,
  DefinicionFlujo,
  EstadoFlujo,
  ResultadoAvance,
} from "./tipos.ts";

const MAX_INTENTOS_POR_DEFECTO = 3;

/**
 * Las opciones del último mensaje que las ofreció.
 *
 * Se toma el ÚLTIMO y no el primero: un paso puede mandar primero la
 * información y después la pregunta con opciones —así abre el paso de cobertura
 * de SEPARÁ— y las opciones vigentes son las de la pregunta.
 */
function opcionesDe(salientes: readonly MensajeSaliente[]): readonly OpcionElegible[] | undefined {
  for (let i = salientes.length - 1; i >= 0; i--) {
    const o = salientes[i]?.opciones;
    if (o && o.length > 0) return o.map((x) => ({ id: x.id, etiqueta: x.etiqueta }));
  }
  return undefined;
}

/**
 * Completa `seleccion` cuando el vecino ESCRIBIÓ su elección en vez de tocar el
 * botón.
 *
 * Los pasos leen `entrante.seleccion` para saber qué eligió. Si el vecino
 * escribe «1» o «poda», eso llega en `texto` y el paso no lo relaciona con nada:
 * repregunta, y el vecino repite el número creyendo que no llegó.
 *
 * Resolverlo acá y no en cada paso tiene dos ventajas: vale para todos los
 * flujos sin tocarlos, y va a valer igual para WhatsApp, donde los botones
 * tienen límites más duros y escribir es todavía más frecuente.
 *
 * `texto` se conserva intacto: un paso que necesite interpretarlo —una cantidad,
 * una dirección— lo sigue teniendo entero.
 */
function conSeleccionResuelta(
  entrante: MensajeEntrante,
  ofrecidas: readonly OpcionElegible[] | undefined,
): MensajeEntrante {
  if (entrante.seleccion || !ofrecidas || ofrecidas.length === 0) return entrante;

  // ESTRICTA a propósito: sólo se traduce si el mensaje ES la elección. Los
  // pasos leen la elección con `textoEfectivo()`, que devuelve `seleccion ??
  // texto`, así que completar `seleccion` reemplaza el texto. Con «escombros, 3
  // bolsas» eso hacía perder la cantidad y el vecino tenía que repetirla.
  const id = resolverOpcion(entrante.texto, ofrecidas);
  return id === null ? entrante : { ...entrante, seleccion: id };
}

export class FlujoDesconocidoError extends Error {
  constructor(nombre: string) {
    super(`No hay ningún flujo registrado con el nombre "${nombre}"`);
    this.name = "FlujoDesconocidoError";
  }
}

export class PasoDesconocidoError extends Error {
  constructor(flujo: string, paso: string) {
    super(`El flujo "${flujo}" no tiene un paso llamado "${paso}"`);
    this.name = "PasoDesconocidoError";
  }
}

/**
 * Arranca un flujo: devuelve el estado inicial y el mensaje de apertura.
 */
export function iniciarFlujo(
  definicion: DefinicionFlujo,
  ctx: ContextoFlujo,
  datosIniciales: DatosFlujo = {},
): ResultadoAvance {
  const paso = definicion.pasos[definicion.pasoInicial];
  if (!paso) throw new PasoDesconocidoError(definicion.nombre, definicion.pasoInicial);

  const salientes = paso.abrir?.(ctx, datosIniciales) ?? [];

  return {
    estado: {
      flujo: definicion.nombre,
      paso: definicion.pasoInicial,
      datos: datosIniciales,
      intentos: 0,
      iniciadoEn: ctx.ahora.toISOString(),
      opcionesOfrecidas: opcionesDe(salientes),
    },
    salientes,
    efectos: [],
  };
}

/**
 * Avanza el flujo con el mensaje que llegó.
 *
 * Cuando una transición avanza a otro paso, el motor concatena el mensaje de
 * apertura del paso destino. Eso evita que cada paso tenga que repetir el
 * prompt del siguiente, que es la forma clásica de que los textos se
 * desincronicen entre lo que dice un paso y lo que espera el otro.
 */
export function avanzarFlujo(
  definicion: DefinicionFlujo,
  estado: EstadoFlujo,
  entrante: MensajeEntrante,
  ctx: ContextoFlujo,
): ResultadoAvance {
  if (definicion.nombre !== estado.flujo) throw new FlujoDesconocidoError(estado.flujo);

  const paso = definicion.pasos[estado.paso];
  if (!paso) throw new PasoDesconocidoError(estado.flujo, estado.paso);

  // Si el vecino escribió su elección en vez de tocar el botón, se traduce
  // ANTES de que el paso la mire. Así ningún paso necesita saber de esto.
  const resuelto = conSeleccionResuelta(entrante, estado.opcionesOfrecidas);
  const transicion = paso.procesar(ctx, estado.datos, resuelto);

  switch (transicion.tipo) {
    case "avanzar": {
      const destino = definicion.pasos[transicion.a];
      if (!destino) throw new PasoDesconocidoError(estado.flujo, transicion.a);

      const datos = { ...estado.datos, ...(transicion.datos ?? {}) };
      const salientes = [...(transicion.mensajes ?? []), ...(destino.abrir?.(ctx, datos) ?? [])];
      return {
        estado: {
          ...estado,
          paso: transicion.a,
          datos,
          intentos: 0,
          opcionesOfrecidas: opcionesDe(salientes),
        },
        salientes,
        efectos: transicion.efectos ?? [],
      };
    }

    case "repetir": {
      const intentos = estado.intentos + 1;
      const techo = paso.maxIntentos ?? MAX_INTENTOS_POR_DEFECTO;
      // Se conserva lo aprendido incluso sin poder avanzar.
      const datos = { ...estado.datos, ...(transicion.datos ?? {}) };

      // Agotados los intentos, el flujo se cierra con una salida útil en lugar
      // de repreguntar para siempre. Un vecino que no puede mandar la foto
      // queda atrapado si el bucle no tiene techo.
      if (intentos >= techo) {
        return {
          estado: null,
          salientes: [
            decir(
              "Veo que no logramos avanzar con este dato. Dejo el pedido sin registrar " +
                "para no cargarlo incompleto. Podés volver a empezar cuando quieras, o " +
                `acercarte a la ${nombreDelArea(ctx.catalogo)} si preferís hacerlo por otra vía.`,
              "nada",
            ),
          ],
          efectos: [{ tipo: "cerrar_conversacion", motivo: `intentos_agotados:${estado.paso}` }],
          abandonadoPor: `intentos_agotados:${estado.paso}`,
        };
      }

      return {
        // Las opciones se actualizan con las del mensaje que se acaba de
        // mandar: si el paso repregunta ofreciendo opciones, son ésas las que
        // valen para el próximo turno.
        estado: {
          ...estado,
          datos,
          intentos,
          opcionesOfrecidas: opcionesDe([transicion.mensaje]) ?? estado.opcionesOfrecidas,
        },
        salientes: [transicion.mensaje],
        efectos: [],
      };
    }

    case "terminar":
      return {
        estado: null,
        salientes: transicion.mensajes,
        efectos: transicion.efectos ?? [],
      };

    case "abandonar":
      return {
        estado: null,
        salientes: transicion.mensajes,
        efectos: [
          ...(transicion.efectos ?? []),
          { tipo: "cerrar_conversacion", motivo: transicion.motivo },
        ],
        abandonadoPor: transicion.motivo,
      };
  }
}

/**
 * ¿El vecino quiere salirse del flujo?
 *
 * Se chequea antes de procesar cualquier paso. Sin esto, alguien que entró por
 * error al flujo de retiro tiene que contestar tres preguntas para poder
 * preguntar otra cosa — exactamente el problema que el QA le marcó al bot
 * anterior.
 */
const PALABRAS_DE_SALIDA = [
  "cancelar",
  "cancela",
  "salir",
  "menu",
  "volver",
  "empezar de nuevo",
  "dejalo",
  "olvidalo",
  "nada",
  "no quiero",
];

export function quiereSalir(entrante: MensajeEntrante): boolean {
  const texto = (entrante.seleccion ?? entrante.texto ?? "").trim();
  if (texto === "") return false;
  // Sólo si el mensaje es CORTO: "cancelar" es salida, pero "no quiero que
  // pasen el jueves porque cancelaron el turno" es una consulta.
  if (texto.split(/\s+/).length > 4) return false;
  const norm = texto
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  return PALABRAS_DE_SALIDA.some(
    (p) => norm === p || norm.startsWith(`${p} `) || norm.endsWith(` ${p}`),
  );
}

/** Salida ordenada cuando el vecino pide cancelar. */
export function cancelar(mensaje?: MensajeSaliente): ResultadoAvance {
  return {
    estado: null,
    salientes: [
      mensaje ??
        decir("Listo, cancelé el pedido. Si necesitás algo más, escribime.", "nada"),
    ],
    efectos: [{ tipo: "cerrar_conversacion", motivo: "cancelado_por_usuario" }],
    abandonadoPor: "cancelado_por_usuario",
  };
}
