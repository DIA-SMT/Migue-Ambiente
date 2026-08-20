/**
 * Fixtures compartidos por los tests de flujos.
 *
 * No se llama `*.test.ts` a propósito: `node --test` descubre por ese sufijo y
 * esto no es una suite, es utilería.
 *
 * El catálogo replica lo que siembran las migraciones 008 y 010, así que un
 * test que pasa acá describe el comportamiento con los datos reales.
 */
import type { Catalogo, PuntoVerde, ZonaRecoleccion } from "../datos/catalogo.ts";
import type { ReglaExclusion } from "../reglas/exclusiones.ts";
import type { LimiteVolumen } from "../reglas/volumen.ts";
import type { MensajeEntrante, MediaEntrante } from "../mensajeria.ts";
import { avanzarFlujo, iniciarFlujo } from "./motor.ts";
import type { ContextoFlujo, DefinicionFlujo, Efecto, EstadoFlujo } from "./tipos.ts";

export const LIMITES_PRUEBA: LimiteVolumen[] = [
  {
    categoria: "escombros",
    etiqueta: "Escombros / Material de construcción",
    limiteValor: 5,
    limiteUnidad: "bolsas",
    pesoMaxBolsaKg: 15,
    accionAlExceder: "parcial_con_ticket",
    textoExceso:
      "Tu pedido excede el límite del servicio gratuito. Retiraremos hasta el máximo permitido.",
    palabras: ["escombro", "escombros", "ladrillo", "cascote", "cemento", "obra"],
    activo: true,
  },
  {
    categoria: "poda",
    etiqueta: "Restos de Poda / Ramas",
    limiteValor: 10,
    limiteUnidad: "bolsas",
    pesoMaxBolsaKg: null,
    accionAlExceder: "parcial_con_ticket",
    textoExceso: null,
    palabras: ["poda", "rama", "ramas", "pasto", "hoja", "hojas"],
    activo: true,
  },
  {
    categoria: "voluminosos",
    etiqueta: "Voluminosos",
    limiteValor: 1,
    limiteUnidad: "m3",
    pesoMaxBolsaKg: null,
    accionAlExceder: "parcial_con_ticket",
    textoExceso: null,
    palabras: ["mueble", "muebles", "sillon", "colchon", "heladera", "tarima"],
    activo: true,
  },
];

const PUNTOS: PuntoVerde[] = [
  { id: "1", nombre: "PV Lamadrid", direccion: "Lamadrid 3700", tipo: "contenedor", horario: "24 hs", materiales: ["reciclables"], observaciones: null, orden: 10 },
  { id: "2", nombre: "PV Viamonte", direccion: "Viamonte e Italia", tipo: "contenedor", horario: "24 hs", materiales: ["reciclables"], observaciones: null, orden: 20 },
];

const ZONAS: ZonaRecoleccion[] = [
  { id: "1", nombre: "Zona Norte", dias: ["lunes", "martes", "viernes"], horaSacar: "14:30 hs", observaciones: null },
  { id: "2", nombre: "Zona Sur", dias: ["martes", "jueves", "sabado"], horaSacar: "14:30 hs", observaciones: null },
];

const REGLAS: ReglaExclusion[] = [
  {
    id: "1",
    nombre: "Fuga de gas",
    palabras: ["gas", "olor a gas"],
    organismo: "Naturgy / Gasnor",
    respuesta: "Si sentís olor a gas, alejate y llamá a la distribuidora.",
    accion: "derivar",
    prioridad: 10,
    activa: true,
  },
];

/** Textos como los siembra la migración 008, con marcadores donde corresponde. */
const TEXTOS = new Map<string, string>([
  [
    "retiro_requisitos",
    "Para gestionar este pedido especial necesito una foto y tu dirección exacta.\n\n⚠️ Regla de Oro: NO saques los residuos a la vereda todavía.",
  ],
  ["retiro_pedir_foto", "Por favor, enviame ahora la foto de los residuos."],
  ["retiro_foto_faltante", "Necesito una imagen para coordinar el retiro."],
  ["retiro_pedir_tipo", "¿Qué tipo de residuo es y qué cantidad aproximada?"],
  ["retiro_pedir_direccion", "Indicame la Dirección Exacta (Calle y Número) y entre qué calles se encuentra."],
  [
    "retiro_confirmacion",
    "✅ Solicitud registrada. {empresa} tiene un plazo de hasta {plazo} (vence el {vencimiento}).\n\nNo saques los residuos hasta que te confirmemos.",
  ],
  ["reclamo_diagnostico", "Para verificar el recorrido necesito tu dirección exacta y desde cuándo no pasa."],
  // Textual de la migración 011. El fixture tiene que espejar producción: si
  // divergen, un test verde no dice nada sobre lo que va a recibir el vecino.
  [
    "reclamo_confirmacion",
    "Reclamo generado. Verificaremos el GPS del interno. Si hubo una falla, {empresa} tiene {plazo} para normalizar el servicio.",
  ],
  ["educa_requisitos", "Necesito nombre de la institución, dirección, responsable y cantidad de alumnos."],
  ["transforma_requisitos", "Necesito la dirección exacta y fotos de la zona."],
  [
    "separa_info",
    "El servicio SEPARÁ pasa los Miércoles y Sábados de 09 a 12 hs (dentro de las 4 avenidas). Dejá tus reciclables limpios y secos.",
  ],
]);

const CONFIG = new Map<string, unknown>([
  ["sla_horas_habiles", 72],
  ["sla_modo", "dias_habiles"],
  ["sla_sabado_habil", true],
  ["empresa_recoleccion", "Transporte 9 de Julio"],
  ["foto_obligatoria_retiro", true],
]);

export function catalogoPrueba(sobreescribir: Partial<Catalogo> = {}): Catalogo {
  return {
    configuracion: CONFIG,
    textos: TEXTOS,
    reglasExclusion: REGLAS,
    limitesVolumen: LIMITES_PRUEBA,
    puntosVerdes: PUNTOS,
    zonas: ZONAS,
    ...sobreescribir,
  };
}

/** Jueves 20/08/2026, 10:00 de Tucumán. Fijo, para que los plazos sean estables. */
export const AHORA = new Date("2026-08-20T13:00:00.000Z");

export function contextoPrueba(catalogo: Catalogo = catalogoPrueba()): ContextoFlujo {
  return { catalogo, ahora: AHORA };
}

// ---------------------------------------------------------------------------
// Simulador de conversación
// ---------------------------------------------------------------------------

export interface Turno {
  readonly texto?: string;
  readonly seleccion?: string;
  readonly imagen?: string;
}

export interface Simulacion {
  readonly estado: EstadoFlujo | null;
  /** Todo lo que el bot dijo, en orden, aplanado. */
  readonly dichos: string[];
  readonly efectos: Efecto[];
  readonly abandonadoPor: string | undefined;
}

function entrante(turno: Turno): MensajeEntrante {
  const media: MediaEntrante | null = turno.imagen
    ? { tipo: "imagen", referencia: turno.imagen, mime: "image/jpeg" }
    : null;
  return {
    canal: "telegram",
    canalUsuarioId: "123456",
    nombreUsuario: "Vecino Prueba",
    texto: turno.texto ?? null,
    media,
    seleccion: turno.seleccion ?? null,
    recibidoEn: AHORA,
  };
}

/**
 * Corre una conversación completa contra un flujo y devuelve todo lo que pasó.
 *
 * Es lo que hace que un flujo entero se pueda testear sin base de datos, sin
 * Redis y sin Telegram: el motor es un reductor puro y los efectos son datos.
 */
export function simular(
  definicion: DefinicionFlujo,
  turnos: readonly Turno[],
  ctx: ContextoFlujo = contextoPrueba(),
): Simulacion {
  const inicio = iniciarFlujo(definicion, ctx);
  let estado = inicio.estado;
  const dichos = inicio.salientes.map((m) => m.texto);
  const efectos: Efecto[] = [...inicio.efectos];
  let abandonadoPor: string | undefined;

  for (const turno of turnos) {
    if (estado === null) break;
    const paso = avanzarFlujo(definicion, estado, entrante(turno), ctx);
    estado = paso.estado;
    dichos.push(...paso.salientes.map((m) => m.texto));
    efectos.push(...paso.efectos);
    if (paso.abandonadoPor) abandonadoPor = paso.abandonadoPor;
  }

  return { estado, dichos, efectos, abandonadoPor };
}

/** Busca un efecto por tipo. */
export function efectoDe<T extends Efecto["tipo"]>(
  efectos: readonly Efecto[],
  tipo: T,
): Extract<Efecto, { tipo: T }> | undefined {
  return efectos.find((e) => e.tipo === tipo) as Extract<Efecto, { tipo: T }> | undefined;
}

/** ¿Alguno de los mensajes del bot contiene este texto? */
export function dijo(dichos: readonly string[], fragmento: string): boolean {
  return dichos.some((d) => d.toLowerCase().includes(fragmento.toLowerCase()));
}
