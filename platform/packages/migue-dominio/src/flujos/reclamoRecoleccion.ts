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
  formatearDireccion,
  interpretarDireccion,
  preguntaPorDireccion,
} from "../reglas/direccion.ts";
import { calcularVencimiento, describirPlazo, formatearFechaLocal } from "../reglas/sla.ts";
import { configSla, leerConfig, leerTexto, tieneTexto } from "../datos/catalogo.ts";
import { interpolar, normalizar } from "../texto.ts";
import { decir, textoEfectivo } from "../mensajeria.ts";
import type { DatosFlujo, DefinicionFlujo, Efecto, Transicion } from "./tipos.ts";
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

        const direccion = interpretarDireccion(texto);
        const direccionGuardada = direccion.completa
          ? formatearDireccion(direccion)
          : (previo.direccion ?? null);

        if (direccionGuardada === null) {
          // Si mandó sólo la foto, el pedido de dirección tiene que ser claro.
          const pregunta =
            texto === "" && foto !== null
              ? "Recibí la foto, gracias. Ahora necesito la dirección exacta: calle y altura."
              : (preguntaPorDireccion(direccion) ?? "Necesito la dirección exacta.");
          return {
            tipo: "repetir",
            // La foto ya recibida se conserva: si el vecino la mandó primero y
            // la dirección después, no hay que volver a pedírsela.
            datos: { fotoReferencia },
            mensaje: decir(pregunta, "texto"),
          };
        }

        const dias = interpretarDias(texto) ?? previo.diasSinServicio ?? null;
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
              diasSinServicio: dias,
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

        return {
          tipo: "terminar",
          mensajes: [decir(confirmacion, "nada")],
          efectos,
        };
      },
    },
  },
};
