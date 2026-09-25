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
import { configSla, describirPuntosVerdes, leerConfig, leerTexto, tieneTexto } from "../datos/catalogo.ts";
import { interpolar } from "../texto.ts";
import { decir, preguntar, textoEfectivo, tieneImagen } from "../mensajeria.ts";
import type { CategoriaFoto, EstadoVeredicto } from "../mensajeria.ts";
import type { ContextoFlujo, DatosFlujo, DefinicionFlujo, Transicion } from "./tipos.ts";

/** Lo que el flujo va acumulando. Guardado en Redis entre mensajes. */
interface DatosRetiro extends DatosFlujo {
  readonly fotoReferencia?: string;
  /** Todo lo que el vecino escribió, turno a turno. */
  readonly texto?: string;
  readonly categoria?: Categoria;
  readonly cantidadValor?: number;
  readonly cantidadUnidad?: string;
  readonly excedeLimite?: boolean;
  readonly retiroParcial?: boolean;
  /** Lo que la visión dijo de la foto aceptada. Va al ticket. */
  readonly fotoVeredicto?: EstadoVeredicto;
  readonly fotoCategoria?: CategoriaFoto | null;
  readonly fotoDetalle?: string | null;
  /** Ya se le pidió otra foto una vez: la próxima se acepta y se marca. */
  readonly fotoObjetada?: boolean;
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

/** El ticket del pedido, con todo lo que se juntó. */
function cerrarRetiro(ctx: ContextoFlujo, d: DatosRetiro, direccion: string): Transicion {
  const sla = configSla(ctx.catalogo);
  const vencimiento = calcularVencimiento(ctx.ahora, sla);

  const confirmacion = interpolar(leerTexto(ctx.catalogo, "retiro_confirmacion"), {
    plazo: describirPlazo(sla),
    vencimiento: formatearFechaLocal(vencimiento),
    empresa: leerConfig(ctx.catalogo, "empresa_recoleccion", "la empresa"),
    direccion,
  });

  return {
    tipo: "terminar",
    mensajes: [decir(confirmacion, "nada")],
    efectos: [
      {
        tipo: "crear_ticket",
        datos: {
          tipo: "Pedido No Habitual",
          direccion,
          tipoResiduo: d.categoria ?? null,
          cantidadValor: d.cantidadValor ?? null,
          cantidadUnidad: d.cantidadUnidad ?? null,
          excedeLimite: d.excedeLimite ?? false,
          retiroParcial: d.retiroParcial ?? false,
          fotoReferencia: d.fotoReferencia ?? null,
          diasSinServicio: null,
          vencimiento,
          derivadoA: null,
          // Si hubo foto pero el veredicto se perdió (estado viejo en Redis de
          // antes del deploy), «no_evaluada» es la verdad: nadie la miró.
          fotoVeredicto: d.fotoVeredicto ?? (d.fotoReferencia ? "no_evaluada" : null),
          fotoCategoria: d.fotoCategoria ?? null,
          fotoDetalle: d.fotoDetalle ?? null,
        },
      },
      // La descarga se encola DESPUÉS del ticket y en el mismo array a
      // propósito: `aplicarEfectos` corre en serie, así el trabajo nace con la
      // fila ya insertada y `registrarMediaGuardada` la encuentra. Es el mismo
      // patrón del reclamo. El file_id aguanta sin problema los minutos que
      // separan la foto del cierre.
      ...(d.fotoReferencia
        ? [
            {
              tipo: "guardar_media",
              referencia: d.fotoReferencia,
              proposito: "retiro_no_habitual",
            } as const,
          ]
        : []),
    ],
  };
}

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
      procesar: (ctx, datos, entrante): Transicion => {
        // EL EPÍGRAFE NO SE TIRA. Este paso recibía `_datos` y descartaba todo
        // lo que el vecino escribiera. En Telegram mandar la foto con el texto
        // encima es el caso NORMAL, no el raro: «Lamadrid 50, son 4 bolsas» iba
        // en el epígrafe, se perdía entero, y el bot volvía a preguntar las dos
        // cosas que el vecino acababa de escribir.
        const acumulado = [leer(datos).texto, textoEfectivo(entrante)]
          .filter(Boolean)
          .join(" · ");

        if (!tieneImagen(entrante)) {
          return {
            tipo: "repetir",
            datos: { texto: acumulado },
            mensaje: decir(leerTexto(ctx.catalogo, "retiro_foto_faltante"), "imagen"),
          };
        }

        const referencia = entrante.media!.referencia;
        const v = entrante.media!.veredicto ?? null;

        // UX decidida con el área: si la visión dice que la foto NO muestra
        // residuos, se pide otra UNA vez; a la segunda se acepta y el ticket
        // queda marcado. «dudosa» y «no_evaluada» avanzan siempre — el costo de
        // equivocarse no es simétrico: repreguntar de más echa a un vecino con
        // un pedido legítimo, marcar de más le suma un chip al panel.
        // Vaciar `retiro_foto_no_corresponde` desde el panel apaga la repregunta.
        if (
          v?.veredicto === "no_corresponde" &&
          leer(datos).fotoObjetada !== true &&
          tieneTexto(ctx.catalogo, "retiro_foto_no_corresponde")
        ) {
          return {
            tipo: "repetir",
            datos: { texto: acumulado, fotoObjetada: true },
            mensaje: decir(
              interpolar(leerTexto(ctx.catalogo, "retiro_foto_no_corresponde"), {
                detalle: v.detalle ?? "no llego a distinguir residuos en la imagen",
              }),
              "imagen",
            ),
          };
        }

        return {
          tipo: "avanzar",
          a: "residuo",
          datos: {
            fotoReferencia: referencia,
            texto: acumulado,
            fotoVeredicto: v?.veredicto ?? "no_evaluada",
            fotoCategoria: v?.categoria ?? null,
            fotoDetalle: v?.detalle ?? null,
          },
          // La descarga NO se encola acá: va junto al ticket, en el cierre.
          // Encolarla en este turno creaba una carrera — el worker guardaba la
          // foto antes de que el ticket existiera, `registrarMediaGuardada`
          // actualizaba cero filas y `photo_url` quedaba null para siempre.
        };
      },
    },

    // -----------------------------------------------------------------------
    residuo: {
      abrir: (ctx) => [
        preguntar(leerTexto(ctx.catalogo, "retiro_pedir_tipo"), OPCIONES_CATEGORIA),
      ],

      procesar: (ctx, datos, entrante): Transicion => {
        const previo = leer(datos);
        const textoTurno = textoEfectivo(entrante);
        // Se mira TODO lo dicho, no sólo este turno: el epígrafe de la foto
        // cuenta igual que un mensaje suelto.
        const texto = [previo.texto, textoTurno].filter(Boolean).join(" · ");
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
            // Se conserva lo acumulado. Es la rama simétrica de la de
            // `precisar`, que ya guardaba la categoría: sin esto, «8 bolsas» se
            // perdía mientras se aclaraba de qué eran.
            datos: { texto },
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

        // QUÉ CANTIDAD GANA, en tres escalones. Acumular texto y quedarse con
        // cualquier número es peligroso en las dos direcciones:
        //
        //   · A ciegas con lo acumulado, «no sé cuántas bolsas» seguía ganando
        //     después de que el vecino dijera «8».
        //   · A ciegas con el turno, «Lamadrid 50» —que es la ALTURA— pisaba las
        //     «4 bolsas» del epígrafe y el pedido pasaba a ser de 50 bolsas.
        //
        // Una cantidad CON unidad es un dato; un número suelto es un candidato.
        // Así el vecino puede corregirse («en realidad son 8 bolsas») sin que
        // una dirección se disfrace de cantidad.
        const delTurno = interpretarCantidad(textoTurno);
        const deTodo = interpretarCantidad(texto);
        const cantidad =
          delTurno.valor !== null && delTurno.unidad !== null
            ? delTurno
            : deTodo.valor !== null && deTodo.unidad !== null
              ? deTodo
              : delTurno;
        const resultado = validarVolumen(cantidad, limite);

        if (resultado.tipo === "precisar") {
          return {
            tipo: "repetir",
            // Se guarda la categoría aunque no podamos avanzar: sin esto, el
            // «8 bolsas» del turno siguiente llegaría sin saber de qué son.
            datos: { categoria, texto },
            mensaje: decir(preguntaParaPrecisar(resultado), "texto"),
          };
        }

        const comunes = {
          categoria,
          cantidadValor: resultado.valorEvaluado,
          cantidadUnidad: resultado.unidadEvaluada,
        };

        // ¿El mensaje que resolvió el tipo y la cantidad ERA la dirección? Pasa
        // cuando el vecino manda la foto con todo escrito en el epígrafe: el
        // paso anterior consume el epígrafe y este turno es el domicilio. Sin
        // esto el bot le pide la dirección que acaba de escribir.
        //
        // Se usa `interpretarDireccion` sobre el turno pelado —exactamente la
        // misma función y el mismo texto que usaría el paso siguiente—, así que
        // no hay ninguna interpretación nueva que pueda equivocarse distinto.
        const yaDioLaDireccion = interpretarDireccion(textoTurno);

        if (resultado.tipo === "dentro") {
          const conDatos = { ...previo, ...comunes, excedeLimite: false, retiroParcial: false };
          return yaDioLaDireccion.completa
            ? cerrarRetiro(ctx, conDatos, formatearDireccion(yaDioLaDireccion))
            : {
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

        const conExceso = { ...previo, ...comunes, excedeLimite: true, retiroParcial: true };
        if (yaDioLaDireccion.completa) {
          const cierre = cerrarRetiro(ctx, conExceso, formatearDireccion(yaDioLaDireccion));
          return cierre.tipo === "terminar"
            ? { ...cierre, mensajes: [decir(resultado.texto, "nada"), ...cierre.mensajes] }
            : cierre;
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

        return cerrarRetiro(ctx, leer(datos), formatearDireccion(direccion));
      },
    },
  },
};
