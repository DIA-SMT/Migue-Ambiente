/**
 * Catálogo: todo lo que un operador puede editar desde el panel, cargado junto
 * y cacheado como una unidad.
 *
 * Se carga entero en vez de repositorio por repositorio porque el bot necesita
 * casi todo en el mismo mensaje: para responder «tengo 8 bolsas de escombros»
 * hacen falta las reglas de exclusión, los límites, los textos y la
 * configuración. Seis consultas cacheadas juntas cuestan un viaje cada minuto;
 * seis cachés independientes vencen en momentos distintos y pueden dejar al bot
 * decidiendo con una mezcla de datos viejos y nuevos.
 */
import type { PostgrestError } from "@supabase/supabase-js";
import { obtenerCliente } from "./cliente.ts";
import { CacheConVencimiento, TTL_REGLAS_MS } from "./cache.ts";
import type { ReglaExclusion } from "../reglas/exclusiones.ts";
import type { LimiteVolumen } from "../reglas/volumen.ts";
import { CONFIG_SLA_POR_DEFECTO, type ConfigSla, type ModoSla } from "../reglas/sla.ts";

export interface PuntoVerde {
  readonly id: string;
  readonly nombre: string;
  readonly direccion: string;
  readonly tipo: "contenedor" | "asistido" | "movil";
  readonly horario: string;
  readonly materiales: readonly string[];
  readonly observaciones: string | null;
  readonly orden: number;
}

export interface ZonaRecoleccion {
  readonly id: string;
  readonly nombre: string;
  readonly dias: readonly string[];
  readonly horaSacar: string | null;
  readonly observaciones: string | null;
}

export interface RespuestaFija {
  readonly id: string;
  readonly nombre: string;
  readonly disparadores: readonly string[];
  readonly modo: "exacto" | "contiene" | "regex";
  readonly respuesta: string;
  readonly prioridad: number;
}

export interface Catalogo {
  readonly configuracion: ReadonlyMap<string, unknown>;
  readonly textos: ReadonlyMap<string, string>;
  readonly reglasExclusion: readonly ReglaExclusion[];
  readonly limitesVolumen: readonly LimiteVolumen[];
  readonly puntosVerdes: readonly PuntoVerde[];
  readonly zonas: readonly ZonaRecoleccion[];
  readonly respuestasFijas: readonly RespuestaFija[];
}

export class ErrorDeCatalogo extends Error {
  constructor(tabla: string, error: PostgrestError) {
    super(`No pude leer ${tabla}: ${error.message} (${error.code ?? "sin código"})`);
    this.name = "ErrorDeCatalogo";
  }
}

// ---------------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------------

async function cargarCatalogo(): Promise<Catalogo> {
  const db = obtenerCliente();

  // En paralelo: son seis consultas independientes contra un endpoint que está
  // a 3 ms de la VPS. Secuenciarlas no aportaría nada.
  const [config, textos, exclusiones, limites, puntos, zonas, fijas] = await Promise.all([
    db.from("configuracion").select("clave, valor"),
    db.from("textos_bot").select("clave, texto"),
    db
      .from("reglas_exclusion")
      .select("id, nombre, palabras, organismo, respuesta, accion, prioridad, activa")
      .eq("activa", true)
      .order("prioridad"),
    db
      .from("limites_volumen")
      .select(
        "categoria, etiqueta, limite_valor, limite_unidad, peso_max_bolsa_kg, accion_al_exceder, texto_exceso, palabras, activo",
      )
      .eq("activo", true),
    db
      .from("puntos_verdes")
      .select("id, nombre, direccion, tipo, horario, materiales, observaciones, orden")
      .eq("activo", true)
      .order("orden"),
    db
      .from("zonas_recoleccion")
      .select("id, nombre, dias, hora_sacar, observaciones")
      .eq("activo", true)
      .order("nombre"),
    db
      .from("respuestas_fijas")
      .select("id, nombre, disparadores, modo, respuesta, prioridad")
      .eq("activa", true)
      .order("prioridad"),
  ]);

  if (config.error) throw new ErrorDeCatalogo("configuracion", config.error);
  if (textos.error) throw new ErrorDeCatalogo("textos_bot", textos.error);
  if (exclusiones.error) throw new ErrorDeCatalogo("reglas_exclusion", exclusiones.error);
  if (limites.error) throw new ErrorDeCatalogo("limites_volumen", limites.error);
  if (puntos.error) throw new ErrorDeCatalogo("puntos_verdes", puntos.error);
  if (zonas.error) throw new ErrorDeCatalogo("zonas_recoleccion", zonas.error);
  if (fijas.error) throw new ErrorDeCatalogo("respuestas_fijas", fijas.error);

  return {
    configuracion: new Map((config.data ?? []).map((f) => [f.clave as string, f.valor])),
    textos: new Map((textos.data ?? []).map((f) => [f.clave as string, f.texto as string])),
    reglasExclusion: (exclusiones.data ?? []).map(
      (f): ReglaExclusion => ({
        id: f.id as string,
        nombre: f.nombre as string,
        palabras: (f.palabras ?? []) as string[],
        organismo: (f.organismo ?? null) as string | null,
        respuesta: f.respuesta as string,
        accion: f.accion as ReglaExclusion["accion"],
        prioridad: f.prioridad as number,
        activa: f.activa as boolean,
      }),
    ),
    limitesVolumen: (limites.data ?? []).map(
      (f): LimiteVolumen => ({
        categoria: f.categoria as LimiteVolumen["categoria"],
        etiqueta: f.etiqueta as string,
        // Postgres devuelve `numeric` como string para no perder precisión.
        // Sin este Number() las comparaciones de límite serían entre strings, y
        // "10" < "5" es verdadero en orden lexicográfico.
        limiteValor: Number(f.limite_valor),
        limiteUnidad: f.limite_unidad as LimiteVolumen["limiteUnidad"],
        pesoMaxBolsaKg: f.peso_max_bolsa_kg === null ? null : Number(f.peso_max_bolsa_kg),
        accionAlExceder: f.accion_al_exceder as LimiteVolumen["accionAlExceder"],
        textoExceso: (f.texto_exceso ?? null) as string | null,
        palabras: (f.palabras ?? []) as string[],
        activo: f.activo as boolean,
      }),
    ),
    puntosVerdes: (puntos.data ?? []).map(
      (f): PuntoVerde => ({
        id: f.id as string,
        nombre: f.nombre as string,
        direccion: f.direccion as string,
        tipo: f.tipo as PuntoVerde["tipo"],
        horario: f.horario as string,
        materiales: (f.materiales ?? []) as string[],
        observaciones: (f.observaciones ?? null) as string | null,
        orden: f.orden as number,
      }),
    ),
    respuestasFijas: (fijas.data ?? []).map(
      (f): RespuestaFija => ({
        id: f.id as string,
        nombre: f.nombre as string,
        disparadores: (f.disparadores ?? []) as string[],
        modo: f.modo as RespuestaFija["modo"],
        respuesta: f.respuesta as string,
        prioridad: f.prioridad as number,
      }),
    ),
    zonas: (zonas.data ?? []).map(
      (f): ZonaRecoleccion => ({
        id: f.id as string,
        nombre: f.nombre as string,
        dias: (f.dias ?? []) as string[],
        horaSacar: (f.hora_sacar ?? null) as string | null,
        observaciones: (f.observaciones ?? null) as string | null,
      }),
    ),
  };
}

const cache = new CacheConVencimiento(cargarCatalogo, { ttlMs: TTL_REGLAS_MS });

/** Catálogo vigente. Cacheado 60 s: una edición del panel se ve sin reiniciar. */
export function obtenerCatalogo(): Promise<Catalogo> {
  return cache.obtener();
}

/** Fuerza la recarga en el próximo acceso. */
export function invalidarCatalogo(): void {
  cache.invalidar();
}

// ---------------------------------------------------------------------------
// Accesores tipados
// ---------------------------------------------------------------------------

/**
 * Lee un valor de configuración con respaldo.
 *
 * El respaldo no es pereza: si un operador borra una fila de `configuracion`,
 * el bot tiene que seguir funcionando con un valor sensato en lugar de romper
 * a mitad de una conversación.
 */
export function leerConfig<T>(catalogo: Catalogo, clave: string, respaldo: T): T {
  const valor = catalogo.configuracion.get(clave);
  return valor === undefined || valor === null ? respaldo : (valor as T);
}

/**
 * Texto del bot por clave.
 *
 * Si falta, devuelve un marcador visible en lugar de una cadena vacía. Un
 * mensaje vacío al vecino es un error silencioso; `[falta texto: x]` se ve en
 * la primera prueba y se corrige desde el panel.
 */
export function leerTexto(catalogo: Catalogo, clave: string): string {
  return catalogo.textos.get(clave) ?? `[falta texto: ${clave}]`;
}

/** Arma la configuración de plazos a partir de lo cargado en la base. */
export function configSla(catalogo: Catalogo): ConfigSla {
  return {
    modo: leerConfig<ModoSla>(catalogo, "sla_modo", CONFIG_SLA_POR_DEFECTO.modo),
    horas: Number(leerConfig(catalogo, "sla_horas_habiles", CONFIG_SLA_POR_DEFECTO.horas)),
    sabadoEsHabil: leerConfig(catalogo, "sla_sabado_habil", CONFIG_SLA_POR_DEFECTO.sabadoEsHabil),
    jornadaDesde: Number(leerConfig(catalogo, "sla_jornada_desde", CONFIG_SLA_POR_DEFECTO.jornadaDesde)),
    jornadaHasta: Number(leerConfig(catalogo, "sla_jornada_hasta", CONFIG_SLA_POR_DEFECTO.jornadaHasta)),
    feriados: leerConfig<readonly string[]>(catalogo, "feriados", CONFIG_SLA_POR_DEFECTO.feriados),
  };
}

/** Los Puntos Verdes formateados para mostrarle al vecino. */
export function describirPuntosVerdes(catalogo: Catalogo, maximo = 5): string {
  const puntos = catalogo.puntosVerdes.slice(0, maximo);
  if (puntos.length === 0) return "No tengo Puntos Verdes cargados en este momento.";
  return puntos
    .map((p) => `• ${p.direccion} — ${p.horario}${p.observaciones ? ` (${p.observaciones})` : ""}`)
    .join("\n");
}

/** Une una lista en castellano: «lunes, martes y viernes». */
function enumerar(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`;
}

/** Los límites de volumen, tal como los tiene cargados el área. */
export function describirLimites(catalogo: Catalogo): string {
  const activos = catalogo.limitesVolumen.filter((l) => l.activo);
  if (activos.length === 0) return "No tengo los límites cargados en este momento.";
  return activos
    .map((l) => {
      const peso = l.pesoMaxBolsaKg ? ` (hasta ${l.pesoMaxBolsaKg} kg cada una)` : "";
      return `• ${l.etiqueta}: hasta ${l.limiteValor} ${l.limiteUnidad}${peso}`;
    })
    .join("\n");
}

/** Los días de recolección por zona. */
export function describirZonas(catalogo: Catalogo): string {
  // Sin filtro por activo: el catálogo ya trae sólo las activas, y el tipo del
  // dominio ni siquiera expone esa columna. Filtrar acá por un campo que no
  // existe fue lo que atajó el typecheck.
  const activas = catalogo.zonas;
  if (activas.length === 0) return "No tengo las zonas de recolección cargadas en este momento.";
  return activas
    .map((z) => `• ${z.nombre}: ${enumerar(z.dias)}${z.horaSacar ? `, sacar a las ${z.horaSacar}` : ""}`)
    .join("\n");
}

/**
 * Los valores con los que se resuelven los marcadores de una respuesta fija.
 *
 * Todos salen del catálogo, o sea de tablas que el área edita desde el panel.
 * Esa es la razón de ser de esto: las direcciones de los Puntos Verdes se
 * escriben UNA vez, en Reglas, y el texto de la fija las referencia. Sin esto,
 * quien escriba la respuesta tendría que copiar las tres direcciones adentro
 * del texto y mantenerlas sincronizadas a mano.
 *
 * Las claves van SIN llaves porque `interpolar` captura el nombre de adentro.
 * La lista de cuáles son válidas vive en `marcadores.ts`, y hay una prueba que
 * verifica que las dos coincidan: agregar un marcador en un lado y olvidarlo en
 * el otro es la forma en que esto se rompe en silencio.
 */
export function valoresDeRespuestaFija(catalogo: Catalogo): Record<string, string> {
  return {
    puntos_verdes: describirPuntosVerdes(catalogo),
    // El plazo que Migue promete, en palabras. NO es `{plazo}` de los flujos:
    // aquél es una fecha concreta calculada contra el momento del pedido, y
    // acá no hay pedido. Éste dice la duración, que es lo que contesta un
    // «¿cuánto tardan?» hecho antes de pedir nada.
    plazo_habitual: `${Number(leerConfig(catalogo, "sla_horas_habiles", 72))} horas hábiles`,
    limites: describirLimites(catalogo),
    zonas: describirZonas(catalogo),
    empresa: String(leerConfig(catalogo, "empresa_recoleccion", "la empresa de recolección")),
  };
}

/**
 * ¿Existe este texto cargado?
 *
 * `leerTexto` devuelve un marcador visible cuando falta, que sirve para
 * detectar el olvido en una prueba. Pero hay mensajes OPCIONALES —el enlace al
 * mapa de recorridos, por ejemplo, que Ambiente todavía no nos pasó— donde
 * mandar «[falta texto: x]» a un vecino sería peor que no mandar nada.
 */
export function tieneTexto(catalogo: Catalogo, clave: string): boolean {
  const texto = catalogo.textos.get(clave);
  return typeof texto === "string" && texto.trim() !== "";
}
