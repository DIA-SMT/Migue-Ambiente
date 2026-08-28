/**
 * FLUJO B · Reclamo por falta de recolección del servicio diario
 *
 * Pasos B1 a B3 de la Especificación Funcional MVP.
 *
 * Diferencia importante con el flujo A: acá la foto es OPCIONAL. La spec lo
 * dice explícitamente («opcional pero deseable») y tiene sentido operativo —
 * el reclamo es que el camión no pasó, y eso se verifica con el GPS del
 * interno, no con la foto. Exigirla dejaría afuera al vecino que ya guardó la
 * bolsa.
 *
 * Lo único bloqueante es la dirección: sin ella no se puede cruzar con el
 * recorrido.
 *
 * NOTA sobre la validación temporal: un borrador propone preguntar a qué hora
 * sacó la basura y cuál es su turno habitual, para educar al vecino si sacó
 * tarde. No está implementado porque mapear una dirección a uno de los 46
 * servicios con sus turnos requiere un dato que no tenemos. Se puede agregar
 * cuando Ambiente nos pase esa tabla; hasta entonces preguntarlo sería
 * interrogar sin poder usar la respuesta.
 */
import { palabraANumero } from "../reglas/cantidad.ts";
import {
  buscarDireccion,
  formatearDireccion,
  preguntaPorDireccion,
} from "../reglas/direccion.ts";
import { calcularVencimiento, describirPlazo, formatearFechaLocal } from "../reglas/sla.ts";
import { configSla, leerConfig, leerTexto, tieneTexto } from "../datos/catalogo.ts";
import { enumerar, interpolar, normalizar } from "../texto.ts";
import { decir, textoEfectivo } from "../mensajeria.ts";
import type {
  ContextoFlujo,
  DatosFlujo,
  DefinicionFlujo,
  Efecto,
  Transicion,
} from "./tipos.ts";
import type { MensajeSaliente } from "../mensajeria.ts";

interface DatosReclamo extends DatosFlujo {
  readonly direccion?: string;
  readonly diasSinServicio?: number | null;
  readonly fotoReferencia?: string | null;
}

/**
 * Cuántos días hace que no pasa el servicio.
 *
 * Se reutiliza el intérprete de cantidades porque el problema es el mismo:
 * extraer un número de texto libre y no confundirlo con otro número de la
 * frase. «Lavalle 500, hace 3 días» tiene dos números y sólo uno es la
 * respuesta.
 */
function interpretarDias(texto: string): number | null {
  // El número tiene que estar PEGADO a la palabra de tiempo. Es lo que evita
  // que «Muñecas 200, hace una semana» lea el 200 de la dirección como
  // cantidad de días.
  const patron = /([\wáéíóúñ]+)\s+(dias?|días?|semanas?|meses?|mes)\b/giu;

  for (const m of texto.matchAll(patron)) {
    const cantidad = palabraANumero(m[1]!);
    if (cantidad === null) continue;

    const unidad = normalizar(m[2]!);
    const dias = unidad.startsWith("semana")
      ? cantidad * 7
      : unidad.startsWith("mes")
        ? cantidad * 30
        : cantidad;

    // Un reclamo de más de 60 días no es una falla del servicio diario:
    // es otro problema y no debería registrarse como éste.
    if (dias >= 1 && dias <= 60) return Math.round(dias);
  }
  return null;
}

/**
 * Lo que el reclamo NO pudo registrar, dicho en voz alta.
 *
 * POR QUÉ EXISTE. El texto de apertura promete tres cosas y este flujo sólo
 * frena por la dirección: la foto es opcional por spec y los días también. Lo
 * que estaba mal no era eso —está bien no frenar— sino que el vecino mandaba la
 * dirección y recibía «Reclamo generado» a secas, exactamente igual que si
 * hubiera mandado todo. Se iba creyendo que el reclamo tenía su foto.
 *
 * NO INVITA A MANDARLO. Una vez creado el ticket el flujo se cierra, y no hay
 * ningún paso esperando: si el mensaje dijera «mandámelo ahora», el vecino
 * mandaría la foto a un flujo que ya no existe y el bot le contestaría
 * cualquier otra cosa. Prometer un turno que no existe es la misma falla que
 * esto viene a arreglar, del otro lado.
 *
 * Devuelve `null` cuando no falta nada, o cuando el área vació la plantilla
 * desde el panel: ahí el reclamo cierra como antes, sin aviso.
 */
function avisoDeLoQueFalta(ctx: ContextoFlujo, datos: DatosReclamo): string | null {
  if (!tieneTexto(ctx.catalogo, "pedido_pendientes")) return null;

  const faltantes: string[] = [];
  if ((datos.fotoReferencia ?? null) === null) {
    faltantes.push(leerTexto(ctx.catalogo, "dato_foto_reclamo"));
  }
  if ((datos.diasSinServicio ?? null) === null) {
    faltantes.push(leerTexto(ctx.catalogo, "dato_dias"));
  }
  if (faltantes.length === 0) return null;

  return interpolar(leerTexto(ctx.catalogo, "pedido_pendientes"), {
    faltante: enumerar(faltantes),
  });
}

export const flujoReclamoRecoleccion: DefinicionFlujo = {
  nombre: "reclamo_recoleccion",
  pasoInicial: "diagnostico",

  pasos: {
    diagnostico: {
      abrir: (ctx) => {
        const mensajes: MensajeSaliente[] = [
          decir(leerTexto(ctx.catalogo, "reclamo_diagnostico"), "texto"),
        ];
        // El enlace al mapa de recorridos es opcional: Ambiente todavía no nos
        // pasó la URL. Si algún día la cargan en el panel, aparece sola.
        if (tieneTexto(ctx.catalogo, "reclamo_info_turnos")) {
          mensajes.push(decir(leerTexto(ctx.catalogo, "reclamo_info_turnos"), "texto"));
        }
        return mensajes;
      },

      procesar: (ctx, datos, entrante): Transicion => {
        const texto = textoEfectivo(entrante);
        const previo = datos as DatosReclamo;

        // La foto llega cuando llega: se guarda sin bloquear el avance.
        const foto = entrante.media?.tipo === "imagen" ? entrante.media.referencia : null;
        const fotoReferencia = foto ?? previo.fotoReferencia ?? null;

        // `buscarDireccion` y no `interpretarDireccion`: acá el vecino cuenta el
        // problema y da el domicilio en el mismo mensaje —«hace 3 días, Lavalle
        // 500»— y el texto entero no es una dirección. El primero prueba el
        // texto completo y, si no da, segmento por segmento. Con el otro, el
        // «Lavalle 500» de ese mensaje se perdía y el bot lo volvía a pedir.
        const direccion = buscarDireccion(texto);
        const direccionGuardada = direccion.completa
          ? formatearDireccion(direccion)
          : (previo.direccion ?? null);

        // Los días se interpretan SIEMPRE, aunque todavía no se pueda avanzar.
        // Antes se leían recién en la rama del cierre, así que decirlos en un
        // turno y la dirección en el siguiente los perdía: el campo estaba
        // declarado, se usaba al armar el ticket, y no se escribía nunca.
        const diasSinServicio = interpretarDias(texto) ?? previo.diasSinServicio ?? null;

        if (direccionGuardada === null) {
          // Si mandó sólo la foto, el pedido de dirección tiene que ser claro.
          const pregunta =
            texto === "" && foto !== null
              ? "Recibí la foto, gracias. Ahora necesito la dirección exacta: calle y altura."
              : (preguntaPorDireccion(direccion) ?? "Necesito la dirección exacta.");
          return {
            tipo: "repetir",
            // Se conserva TODO lo aprendido, no sólo la foto: si el vecino la
            // mandó primero y la dirección después, no hay que volver a pedirle
            // nada de lo que ya dijo.
            datos: { fotoReferencia, diasSinServicio },
            mensaje: decir(pregunta, "texto"),
          };
        }

        const sla = configSla(ctx.catalogo);
        const vencimiento = calcularVencimiento(ctx.ahora, sla);

        const confirmacion = interpolar(leerTexto(ctx.catalogo, "reclamo_confirmacion"), {
          plazo: describirPlazo(sla),
          vencimiento: formatearFechaLocal(vencimiento),
          empresa: leerConfig(ctx.catalogo, "empresa_recoleccion", "la empresa"),
          direccion: direccionGuardada,
        });

        const efectos: Efecto[] = [
          {
            tipo: "crear_ticket",
            datos: {
              tipo: "Falta de Recolección",
              direccion: direccionGuardada,
              tipoResiduo: null,
              cantidadValor: null,
              cantidadUnidad: null,
              excedeLimite: false,
              retiroParcial: false,
              fotoReferencia,
              diasSinServicio,
              vencimiento,
              derivadoA: null,
            },
          },
        ];
        if (fotoReferencia !== null) {
          efectos.push({
            tipo: "guardar_media",
            referencia: fotoReferencia,
            proposito: "reclamo_recoleccion",
          });
        }

        // El aviso va como mensaje APARTE de la confirmación: la confirmación se
        // tiene que poder reenviar o guardar sin arrastrar nada más.
        const aviso = avisoDeLoQueFalta(ctx, { fotoReferencia, diasSinServicio });

        return {
          tipo: "terminar",
          mensajes:
            aviso === null
              ? [decir(confirmacion, "nada")]
              : [decir(confirmacion, "nada"), decir(aviso, "nada")],
          efectos,
        };
      },
    },
  },
};
