/**
 * Puertos falsos para probar el orquestador.
 *
 * Registran todo lo que el orquestador intentó hacer, así los tests pueden
 * afirmar sobre efectos —«creó un ticket», «registró la pregunta sin
 * responder»— sin base de datos ni red.
 */
import { almacenEnMemoria, type AlmacenEstado } from "./almacen.ts";
import type { Persistencia, Puertos } from "./orquestador.ts";
import type { Clasificacion, Intencion } from "../ia/router.ts";
import type { Respuesta } from "../conocimiento/responder.ts";
import type { Catalogo } from "../datos/catalogo.ts";
import type { Efecto } from "../flujos/tipos.ts";
import type { MensajeSaliente } from "../mensajeria.ts";
import type { TrazaMensaje } from "../datos/conversaciones.ts";
import type { MotivoSinRespuesta, Procedencia } from "../datos/registros.ts";
import { AHORA, catalogoPrueba } from "../flujos/_fixtures.ts";

export interface Registro {
  readonly conversacionesAbiertas: number;
  readonly entrantes: number;
  readonly salientes: Array<{ texto: string; traza: TrazaMensaje }>;
  readonly efectos: Efecto[];
  readonly sinRespuesta: Array<{ pregunta: string; motivo: MotivoSinRespuesta }>;
  readonly cierres: Array<"cerrada" | "derivada" | "abandonada">;
  readonly flujosGuardados: Array<{ flujo: string | null; paso: string | null }>;
}

export interface PuertosPrueba extends Puertos {
  readonly registro: Registro;
  readonly almacen: AlmacenEstado & { readonly tamano: () => number };
}

export interface OpcionesPuertos {
  readonly catalogo?: Catalogo;
  /** Intención que devuelve el clasificador falso. */
  readonly intencion?: Intencion;
  readonly confianza?: number;
  /** Respuesta que devuelve la cadena de conocimiento falsa. */
  readonly respuesta?: Respuesta;
  readonly ahora?: Date;
}

const TRAZA_IA = {
  modelo: "modelo-de-prueba",
  tokensEntrada: 100,
  tokensSalida: 20,
  costoUsd: 0.0001,
  latenciaMs: 500,
};

export function puertosPrueba(opciones: OpcionesPuertos = {}): PuertosPrueba {
  const registro: Registro = {
    conversacionesAbiertas: 0,
    entrantes: 0,
    salientes: [],
    efectos: [],
    sinRespuesta: [],
    cierres: [],
    flujosGuardados: [],
  };
  // `conversacionesAbiertas` y `entrantes` son contadores; se mutan por
  // referencia sobre un objeto mutable interno.
  const contadores = { conversaciones: 0, entrantes: 0 };

  const persistencia: Persistencia = {
    async abrirConversacion() {
      contadores.conversaciones++;
      return { id: "conv-prueba", esNueva: contadores.conversaciones === 1 };
    },
    async registrarEntrante() {
      contadores.entrantes++;
      return `msg-${contadores.entrantes}`;
    },
    async registrarSaliente(_id: string, saliente: MensajeSaliente, traza: TrazaMensaje) {
      registro.salientes.push({ texto: saliente.texto, traza });
    },
    async actualizarFlujo(_id: string, flujo: string | null, paso: string | null) {
      registro.flujosGuardados.push({ flujo, paso });
    },
    async cerrarConversacion(_id: string, estado) {
      registro.cierres.push(estado);
    },
    async aplicarEfectos(efectos: readonly Efecto[], _procedencia: Procedencia) {
      registro.efectos.push(...efectos);
      return efectos.map((e) => ({ efecto: e.tipo, ok: true, id: `${e.tipo}-1` }));
    },
    async registrarSinRespuesta(o) {
      registro.sinRespuesta.push({ pregunta: o.pregunta, motivo: o.motivo });
      return { id: "sr-1", agrupada: false };
    },
  };

  const catalogo = opciones.catalogo ?? catalogoPrueba();

  return {
    almacen: almacenEnMemoria(),
    obtenerCatalogo: async () => catalogo,

    async clasificar(): Promise<Clasificacion> {
      return {
        intencion: opciones.intencion ?? "consulta_libre",
        confianza: opciones.confianza ?? 0.9,
        porAtajo: false,
        ...TRAZA_IA,
      };
    },

    async responder(): Promise<Respuesta> {
      return (
        opciones.respuesta ?? {
          tipo: "sintetizada",
          texto: "Los Puntos Verdes de contenedor funcionan las 24 hs.",
          coincidencias: [
            {
              origen: "faq",
              id: "faq-1",
              titulo: "¿Dónde llevo reciclables?",
              texto: "En los Puntos Verdes.",
              documentoTitulo: null,
              pagina: null,
              rank: 1,
              difuso: false,
            },
          ],
          traza: { ...TRAZA_IA, consultaExpandida: "puntos verdes reciclables", confianza: 0.9 },
        }
      );
    },

    persistencia,
    ahora: () => opciones.ahora ?? AHORA,

    get registro() {
      return {
        ...registro,
        conversacionesAbiertas: contadores.conversaciones,
        entrantes: contadores.entrantes,
      };
    },
  } as PuertosPrueba;
}

/** Todo lo que dijo el bot, concatenado, para afirmaciones rápidas. */
export function dicho(puertos: PuertosPrueba): string {
  return puertos.registro.salientes.map((s) => s.texto).join("\n---\n");
}
