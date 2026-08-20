/**
 * Tipos del motor de flujos.
 *
 * Decisión central: el motor es un REDUCTOR PURO. No escribe en la base, no
 * llama a Telegram, no descarga fotos. Recibe estado más mensaje entrante y
 * devuelve estado nuevo, mensajes a enviar y una lista de EFECTOS declarados
 * que el orquestador ejecuta.
 *
 * El motivo es poder testear los cuatro flujos completos —incluida la
 * generación de tickets— sin base de datos, sin red y sin canal conectado. Un
 * flujo con efectos secundarios adentro sólo se puede probar levantando todo.
 */
import type { Catalogo } from "../datos/catalogo.ts";
import type { MensajeEntrante, MensajeSaliente } from "../mensajeria.ts";

export type NombreFlujo =
  | "retiro_no_habitual"
  | "reclamo_recoleccion"
  | "programa_educa"
  | "programa_transforma"
  /**
   * SEPARÁ no está como flujo en la spec —figura como información— pero el
   * documento de QA agrega un caso que sí requiere capturar datos: los
   * domicilios FUERA de las 4 avenidas, donde el recorrido no llega y hay que
   * coordinar el retiro con el equipo.
   */
  | "programa_separa";

/** Datos que el flujo fue capturando. Serializable: vive en Redis. */
export type DatosFlujo = Readonly<Record<string, unknown>>;

export interface EstadoFlujo {
  readonly flujo: NombreFlujo;
  readonly paso: string;
  readonly datos: DatosFlujo;
  /** Veces que se repitió el paso actual. Corta los bucles infinitos. */
  readonly intentos: number;
  readonly iniciadoEn: string;
}

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

export interface DatosTicket {
  readonly tipo: "Pedido No Habitual" | "Falta de Recolección";
  readonly direccion: string;
  readonly tipoResiduo: string | null;
  readonly cantidadValor: number | null;
  readonly cantidadUnidad: string | null;
  readonly excedeLimite: boolean;
  readonly retiroParcial: boolean;
  readonly fotoReferencia: string | null;
  readonly diasSinServicio: number | null;
  readonly vencimiento: Date;
  readonly derivadoA: string | null;
}

export interface DatosSolicitudPrograma {
  readonly programa: "educa" | "transforma" | "separa";
  readonly institucion: string | null;
  readonly responsable: string | null;
  readonly cantidadAlumnos: number | null;
  readonly direccion: string;
  readonly telefonoContacto: string | null;
  readonly informacionAdicional: string | null;
}

export type Efecto =
  | { readonly tipo: "crear_ticket"; readonly datos: DatosTicket }
  | { readonly tipo: "crear_solicitud_programa"; readonly datos: DatosSolicitudPrograma }
  /**
   * Encola la descarga de una foto. El flujo NO espera: guarda la referencia y
   * sigue, para que un vecino no quede esperando la bajada de 5 MB.
   */
  | { readonly tipo: "guardar_media"; readonly referencia: string; readonly proposito: string }
  | { readonly tipo: "cerrar_conversacion"; readonly motivo: string };

// ---------------------------------------------------------------------------
// Definición de un flujo
// ---------------------------------------------------------------------------

export interface ContextoFlujo {
  readonly catalogo: Catalogo;
  /** Inyectado, no `new Date()`: es lo que hace testeable el cálculo de plazos. */
  readonly ahora: Date;
}

export type Transicion =
  /** Pasa al paso `a`. El motor agrega solo el mensaje de apertura del destino. */
  | {
      readonly tipo: "avanzar";
      readonly a: string;
      readonly datos?: DatosFlujo;
      readonly mensajes?: readonly MensajeSaliente[];
      readonly efectos?: readonly Efecto[];
    }
  /**
   * Se queda en el mismo paso. Incrementa el contador de intentos.
   *
   * `datos` existe porque un paso puede aprender algo aunque no pueda avanzar:
   * en «tengo escombros, no sé cuántas bolsas» ya quedó determinada la
   * categoría, y hay que guardarla. Sin esto, el vecino contesta «8» en el
   * turno siguiente y el flujo ya no sabe de qué eran.
   */
  | {
      readonly tipo: "repetir";
      readonly mensaje: MensajeSaliente;
      readonly datos?: DatosFlujo;
    }
  /** Cierra el flujo con éxito. */
  | {
      readonly tipo: "terminar";
      readonly mensajes: readonly MensajeSaliente[];
      readonly efectos?: readonly Efecto[];
    }
  /** Cierra el flujo sin completarlo (derivación, abandono). */
  | {
      readonly tipo: "abandonar";
      readonly mensajes: readonly MensajeSaliente[];
      readonly motivo: string;
      readonly efectos?: readonly Efecto[];
    };

export interface DefinicionPaso {
  /**
   * Mensaje con que se abre el paso. Puede devolver varios: el flujo A manda
   * los requisitos y el pedido de foto como dos mensajes seguidos, que es como
   * lo describe la spec.
   */
  readonly abrir?: (ctx: ContextoFlujo, datos: DatosFlujo) => readonly MensajeSaliente[];
  /** Procesa la respuesta del vecino. */
  readonly procesar: (
    ctx: ContextoFlujo,
    datos: DatosFlujo,
    entrante: MensajeEntrante,
  ) => Transicion;
  /**
   * Intentos permitidos antes de ofrecer una salida.
   *
   * La spec dice «loop hasta recibir imagen» para la foto del flujo A. Un
   * bucle sin techo deja al vecino atrapado: si no puede sacar la foto, no
   * tiene forma de salir más que abandonar la conversación. Con techo, el bot
   * le ofrece una alternativa.
   */
  readonly maxIntentos?: number;
}

export interface DefinicionFlujo {
  readonly nombre: NombreFlujo;
  readonly pasoInicial: string;
  readonly pasos: Readonly<Record<string, DefinicionPaso>>;
}

export interface ResultadoAvance {
  /** null = el flujo terminó y hay que limpiar el estado. */
  readonly estado: EstadoFlujo | null;
  readonly salientes: readonly MensajeSaliente[];
  readonly efectos: readonly Efecto[];
  /** Presente sólo si el flujo cerró sin completarse. */
  readonly abandonadoPor?: string;
}
