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
  readonly salientes: Array<{
    id: string;
    texto: string;
    traza: TrazaMensaje;
    /** Las opciones que se le ofrecieron. Vacío si el mensaje no ofrecía ninguna. */
    opciones: Array<{ id: string; etiqueta: string }>;
  }>;
  readonly efectos: Efecto[];
  readonly sinRespuesta: Array<{ pregunta: string; motivo: MotivoSinRespuesta }>;
  readonly votos: Array<{ voto: string; sobre: string; mensajeId: string | null }>;
  /**
   * Los mensajes que ya tienen voto, para imitar el bloqueo de la 029.
   *
   * Va aparte de `votos` y no se deduce de el: `votos` guarda TODOS los
   * intentos —incluidos los segundos toques— porque una prueba necesita poder
   * afirmar que el bot intento registrar y que la base lo rechazo.
   */
  readonly mensajesVotados: Set<string>;
  /** Los textos que se intentaron pegar como explicación de un voto. */
  readonly comentariosIntentados: string[];
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
    votos: [],
    mensajesVotados: new Set<string>(),
    comentariosIntentados: [],
    cierres: [],
    flujosGuardados: [],
  };
  // `conversacionesAbiertas` y `entrantes` son contadores; se mutan por
  // referencia sobre un objeto mutable interno.
  const contadores = { conversaciones: 0, entrantes: 0, salientes: 0 };

  const persistencia: Persistencia = {
    async abrirConversacion() {
      contadores.conversaciones++;
      return { id: "conv-prueba", esNueva: contadores.conversaciones === 1 };
    },
    async registrarEntrante() {
      contadores.entrantes++;
      return `msg-${contadores.entrantes}`;
    },
    // DEVUELVE UN ID, igual que el real, y no es un detalle: el orquestador usa
    // el id del primer saliente para pegárselo a los botones de voto. Un doble
    // que devolvía `undefined` hacía que ese camino nunca se ejecutara en la
    // suite, así que las pruebas no podían ver ni el bug ni el arreglo.
    async registrarSaliente(_id: string, saliente: MensajeSaliente, traza: TrazaMensaje) {
      contadores.salientes += 1;
      const id = `sal-${contadores.salientes}`;
      registro.salientes.push({
        id,
        texto: saliente.texto,
        traza,
        opciones: (saliente.opciones ?? []).map((o) => ({ id: o.id, etiqueta: o.etiqueta })),
      });
      return id;
    },
    // Devuelve el origen del ULTIMO saliente registrado, leyendo el mismo
    // registro que las pruebas inspeccionan. Un doble que devolviera null fijo
    // haria que la rama de derivacion no se ejecutara nunca en la suite — el
    // mismo error que ya tuvo `registrarSaliente` cuando no devolvia id.
    async ultimoOrigenSaliente(_id: string) {
      const ultimo = registro.salientes.at(-1);
      return ultimo?.traza.origenRespuesta ?? null;
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
    async registrarVoto(_id: string, voto, mensajeId: string | null, sobre: string) {
      // Se guarda el `mensajeId` para poder afirmar CONTRA QUÉ quedó el voto.
      // Sin esto una prueba sólo puede decir que se votó, no que se votó lo que
      // correspondía — y ese era exactamente el bug.
      registro.votos.push({ voto, sobre, mensajeId });

      // El doble imita el bloqueo de la 029: el primer voto sobre un mensaje se
      // registra, y los siguientes devuelven `yaHabiaVotado`. Se lleva por
      // mensaje y no un simple contador porque votar la respuesta y después el
      // trámite son dos mensajes distintos y los dos tienen que entrar.
      //
      // La clave usa `mensajeId ?? "(inferido)"`: cuando el botón no trae el id
      // la base cae a su respaldo por conversación, que en una misma
      // conversación siempre resuelve al mismo mensaje. Tratar cada emoji suelto
      // como un mensaje nuevo dejaría pasar exactamente el bug que se arregló.
      const clave = mensajeId ?? "(inferido)";
      const yaHabiaVotado = registro.mensajesVotados.has(clave);
      registro.mensajesVotados.add(clave);
      return { id: "v-1", yaHabiaVotado };
    },
    // El doble registra el INTENTO y devuelve false, que es el caso normal: la
    // enorme mayoría de los mensajes no explican ningún voto. Una prueba que
    // necesite el otro caso reemplaza este método.
    async comentarVoto(_id: string, comentario: string) {
      registro.comentariosIntentados.push(comentario);
      return false;
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
