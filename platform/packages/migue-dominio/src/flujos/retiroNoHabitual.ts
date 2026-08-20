/**
 * FLUJO A · Solicitud de retiro de residuos no habituales
 *
 * Sigue los pasos A1 a A5 de la Especificación Funcional MVP:
 * requisitos → foto (bloqueante) → tipificación y volumen → dirección → ticket.
 *
 * Dos cosas que la spec no dice y este flujo hace igual:
 *
 * 1. Pregunta tipo y cantidad JUNTOS, y acepta que vengan en el mismo mensaje.
 *    La spec ya lo plantea así en A3, y el QA del bot anterior era explícito:
 *    «da muchas vueltas y me vuelve a preguntar». Si el vecino escribió
 *    «8 bolsas de escombros», eso alcanza y no se le pregunta de nuevo.
 *
 * 2. La foto tiene techo de intentos. La spec dice «loop hasta recibir imagen»,
 *    pero un bucle sin salida deja atrapado a quien no puede sacar la foto.
 */
import { interpretarCantidad } from "../reglas/cantidad.ts";
import { interpretarDireccion, formatearDireccion, preguntaPorDireccion } from "../reglas/direccion.ts";
import {
  detectarCategoria,
  limiteDe,
  preguntaParaPrecisar,
  validarVolumen,
  type Categoria,
} from "../reglas/volumen.ts";
import { calcularVencimiento, describirPlazo, formatearFechaLocal } from "../reglas/sla.ts";
import { configSla, describirPuntosVerdes, leerConfig, leerTexto } from "../datos/catalogo.ts";
import { interpolar } from "../texto.ts";
import { decir, preguntar, textoEfectivo, tieneImagen } from "../mensajeria.ts";
import type { ContextoFlujo, DatosFlujo, DefinicionFlujo, Transicion } from "./tipos.ts";

/** Lo que el flujo va acumulando. Guardado en Redis entre mensajes. */
interface DatosRetiro extends DatosFlujo {
  readonly fotoReferencia?: string;
  readonly categoria?: Categoria;
  readonly cantidadValor?: number;
  readonly cantidadUnidad?: string;
  readonly excedeLimite?: boolean;
  readonly retiroParcial?: boolean;
}

function leer(datos: DatosFlujo): DatosRetiro {
  return datos as DatosRetiro;
}

/** Opciones de tipificación. Se repiten en dos lugares, así que van una vez. */
const OPCIONES_CATEGORIA = [
  { id: "escombros", etiqueta: "Escombros / material de construcción" },
  { id: "poda", etiqueta: "Restos de poda / ramas" },
  { id: "voluminosos", etiqueta: "Muebles, electrodomésticos, chatarra" },
] as const;

// ---------------------------------------------------------------------------
// Definición
// ---------------------------------------------------------------------------

export const flujoRetiroNoHabitual: DefinicionFlujo = {
  nombre: "retiro_no_habitual",
  pasoInicial: "foto",

  pasos: {
    // -----------------------------------------------------------------------
    foto: {
      abrir: (ctx) => [
        decir(leerTexto(ctx.catalogo, "retiro_requisitos"), "nada"),
        decir(leerTexto(ctx.catalogo, "retiro_pedir_foto"), "imagen"),
      ],
      maxIntentos: 4,
      procesar: (ctx, _datos, entrante): Transicion => {
        if (!tieneImagen(entrante)) {
          return {
            tipo: "repetir",
            mensaje: decir(leerTexto(ctx.catalogo, "retiro_foto_faltante"), "imagen"),
          };
        }

        const referencia = entrante.media!.referencia;
        return {
          tipo: "avanzar",
          a: "residuo",
          datos: { fotoReferencia: referencia },
          // La descarga se encola: el flujo no espera a que bajen 5 MB.
          efectos: [{ tipo: "guardar_media", referencia, proposito: "retiro_no_habitual" }],
        };
      },
    },

    // -----------------------------------------------------------------------
    residuo: {
      abrir: (ctx) => [
        preguntar(leerTexto(ctx.catalogo, "retiro_pedir_tipo"), OPCIONES_CATEGORIA),
      ],

      procesar: (ctx, datos, entrante): Transicion => {
        const texto = textoEfectivo(entrante);
        const previo = leer(datos);
        const limites = ctx.catalogo.limitesVolumen;

        // La categoría puede venir de un botón, del texto, o de un turno previo.
        const categoria =
          previo.categoria ??
          (["escombros", "poda", "voluminosos"].includes(entrante.seleccion ?? "")
            ? (entrante.seleccion as Categoria)
            : detectarCategoria(texto, limites));

        if (categoria === null) {
          return {
            tipo: "repetir",
            mensaje: preguntar(
              "No me quedó claro de qué tipo de residuo se trata. ¿Cuál de estos es?",
              OPCIONES_CATEGORIA,
            ),
          };
        }

        const limite = limiteDe(categoria, limites);
        if (limite === null) {
          // La categoría existe pero su límite está desactivado en el panel.
          return {
            tipo: "abandonar",
            motivo: `sin_limite_configurado:${categoria}`,
            mensajes: [
              decir(
                "Ese tipo de residuo no se está gestionando por este canal en este momento. " +
                  "Un agente de Ambiente puede orientarte mejor.",
                "nada",
              ),
            ],
          };
        }

        const cantidad = interpretarCantidad(texto);
        const resultado = validarVolumen(cantidad, limite);

        if (resultado.tipo === "precisar") {
          return {
            tipo: "repetir",
            // Se guarda la categoría aunque no podamos avanzar: sin esto, el
            // «8 bolsas» del turno siguiente llegaría sin saber de qué son.
            datos: { categoria },
            mensaje: decir(preguntaParaPrecisar(resultado), "texto"),
          };
        }

        const comunes = {
          categoria,
          cantidadValor: resultado.valorEvaluado,
          cantidadUnidad: resultado.unidadEvaluada,
        };

        if (resultado.tipo === "dentro") {
          return {
            tipo: "avanzar",
            a: "direccion",
            datos: { ...comunes, excedeLimite: false, retiroParcial: false },
          };
        }

        // Excede. Qué hacer lo decide la tabla, no el código: la spec dice
        // retiro parcial con ticket, un borrador dice derivar sin ticket.
        if (resultado.accion === "derivar_sin_ticket") {
          return {
            tipo: "abandonar",
            motivo: "excede_limite_derivado",
            mensajes: [
              decir(resultado.texto, "nada"),
              decir(
                `Podés acercarlo a un Punto Verde:\n${describirPuntosVerdes(ctx.catalogo)}`,
                "nada",
              ),
            ],
          };
        }

        return {
          tipo: "avanzar",
          a: "direccion",
          datos: { ...comunes, excedeLimite: true, retiroParcial: true },
          mensajes: [decir(resultado.texto, "nada")],
        };
      },
    },

    // -----------------------------------------------------------------------
    direccion: {
      abrir: (ctx) => [decir(leerTexto(ctx.catalogo, "retiro_pedir_direccion"), "texto")],

      procesar: (ctx, datos, entrante): Transicion => {
        const direccion = interpretarDireccion(textoEfectivo(entrante));

        if (!direccion.completa) {
          return {
            tipo: "repetir",
            mensaje: decir(preguntaPorDireccion(direccion) ?? "Necesito la dirección exacta.", "texto"),
          };
        }

        const d = leer(datos);
        const sla = configSla(ctx.catalogo);
        const vencimiento = calcularVencimiento(ctx.ahora, sla);

        const confirmacion = interpolar(leerTexto(ctx.catalogo, "retiro_confirmacion"), {
          plazo: describirPlazo(sla),
          vencimiento: formatearFechaLocal(vencimiento),
          empresa: leerConfig(ctx.catalogo, "empresa_recoleccion", "la empresa"),
          direccion: formatearDireccion(direccion),
        });

        return {
          tipo: "terminar",
          mensajes: [decir(confirmacion, "nada")],
          efectos: [
            {
              tipo: "crear_ticket",
              datos: {
                tipo: "Pedido No Habitual",
                direccion: formatearDireccion(direccion),
                tipoResiduo: d.categoria ?? null,
                cantidadValor: d.cantidadValor ?? null,
                cantidadUnidad: d.cantidadUnidad ?? null,
                excedeLimite: d.excedeLimite ?? false,
                retiroParcial: d.retiroParcial ?? false,
                fotoReferencia: d.fotoReferencia ?? null,
                diasSinServicio: null,
                vencimiento,
                derivadoA: null,
              },
            },
          ],
        };
      },
    },
  },
};
