/**
 * Del mensaje canónico a los envíos de WhatsApp.
 *
 * Semántico a propósito: acá se decide QUÉ se manda (texto, botones o lista) y
 * cómo se acomodan los límites del canal; el JSON del wire lo arma cliente.ts.
 * Así esto se prueba sin conocer la forma del POST, igual que en Telegram.
 *
 * Texto plano sin markdown, misma decisión que Telegram y por el mismo motivo:
 * los textos los edita el personal y los redacta un modelo, y un asterisco
 * suelto no puede romper un envío.
 *
 * Los límites de la Cloud API que gobiernan este archivo:
 *   texto              4096 caracteres
 *   body interactivo   1024
 *   botones reply      máximo 3, título ≤20
 *   listas             hasta 10 filas; título ≤24, descripción ≤72, botón ≤20
 *   ids                ≤256 bytes
 * Se cuentan CODE POINTS ([...s].length), no unidades UTF-16: un emoji no
 * puede hacer mentir la cuenta.
 */
import type { MensajeSaliente, OpcionRespuesta } from "@migue/dominio";
import { partirTexto } from "../comun.ts";

const MAX_TEXTO = 4096;
const MAX_BODY_INTERACTIVO = 1024;
const MAX_TITULO_BOTON = 20;
const MAX_TITULO_FILA = 24;
const MAX_DESCRIPCION_FILA = 72;
const MAX_BOTONES = 3;
const MAX_FILAS = 10;
const MAX_ID_BYTES = 256;

/**
 * El botón que abre la lista. Clavado en código con el mismo argumento que la
 * disculpa de error: el renderizador no tiene catálogo a mano y no puede tener
 * un camino que falle leyendo la base.
 */
const BOTON_LISTA = "Ver opciones";

export interface BotonWhatsApp {
  readonly id: string;
  readonly titulo: string;
}

export interface FilaDeLista {
  readonly id: string;
  readonly titulo: string;
  readonly descripcion: string | null;
}

export type EnvioWhatsApp =
  | { readonly tipo: "texto"; readonly texto: string }
  | { readonly tipo: "botones"; readonly texto: string; readonly botones: readonly BotonWhatsApp[] }
  | {
      readonly tipo: "lista";
      readonly texto: string;
      readonly boton: string;
      readonly filas: readonly FilaDeLista[];
    };

/** Largo en code points, que es como cuenta Meta. */
function largo(texto: string): number {
  return [...texto].length;
}

/** Corta por palabra a lo sumo `maximo` code points, con «…» si no entró. */
function recortarPorPalabra(texto: string, maximo: number): string {
  if (largo(texto) <= maximo) return texto;
  const puntos = [...texto].slice(0, maximo - 1).join("");
  const ultimoEspacio = puntos.lastIndexOf(" ");
  // Si cortar por palabra dejaría un muñón (menos de la mitad), se corta seco.
  const base = ultimoEspacio > (maximo - 1) / 2 ? puntos.slice(0, ultimoEspacio) : puntos;
  return `${base.trimEnd()}…`;
}

/**
 * Etiqueta larga → título de fila + descripción con la etiqueta COMPLETA.
 *
 * Así no se pierde información: una etiqueta como «Taller o charla para una
 * institución (EDUCÁ)» —la que tenía el menú antes de la 038— no entra en 24,
 * pero la descripción de la fila la muestra entera.
 *
 * Hoy ninguna opción del menú lo necesita: la 038 las acortó justamente para que
 * se lean de un vistazo. Esto sigue acá porque las opciones de los PASOS de un
 * flujo salen de la base —las categorías de residuo, por ejemplo— y ahí el largo
 * lo decide quien las carga desde el panel.
 */
export function partirEtiqueta(etiqueta: string): { titulo: string; descripcion: string | null } {
  if (largo(etiqueta) <= MAX_TITULO_FILA) return { titulo: etiqueta, descripcion: null };
  return {
    titulo: recortarPorPalabra(etiqueta, MAX_TITULO_FILA),
    descripcion: recortarPorPalabra(etiqueta, MAX_DESCRIPCION_FILA),
  };
}

/**
 * Los títulos de botón, recortados y SIN repetidos: Meta rechaza el envío
 * entero si dos botones quedan con el mismo título, y perder la respuesta por
 * un recorte sería un fallo silencioso.
 */
function titulosDeBotones(opciones: readonly OpcionRespuesta[]): BotonWhatsApp[] {
  const vistos = new Map<string, number>();
  return opciones.map((o) => {
    let titulo = recortarPorPalabra(o.etiqueta, MAX_TITULO_BOTON);
    const repeticiones = vistos.get(titulo) ?? 0;
    vistos.set(titulo, repeticiones + 1);
    if (repeticiones > 0) {
      const sufijo = ` ${repeticiones + 1}`;
      titulo = `${recortarPorPalabra(o.etiqueta, MAX_TITULO_BOTON - largo(sufijo))}${sufijo}`;
    }
    return { id: o.id, titulo };
  });
}

/**
 * Parte el cuerpo cuando hay opciones: todo va como textos sueltos salvo la
 * última parte, que es el body del interactivo (≤1024).
 */
function partirCuerpoInteractivo(texto: string): { preludios: string[]; body: string } {
  const partes = partirTexto(texto === "" ? " " : texto, MAX_TEXTO);
  const ultima = partes.pop() ?? " ";
  if (largo(ultima) <= MAX_BODY_INTERACTIVO) return { preludios: partes, body: ultima };
  const finas = partirTexto(ultima, MAX_BODY_INTERACTIVO);
  const body = finas.pop() ?? " ";
  return { preludios: [...partes, ...finas], body };
}

export function renderizar(saliente: MensajeSaliente): EnvioWhatsApp[] {
  // El descarte silencioso de ids imposibles es la política del canal, igual
  // que en Telegram (allá el tope es 64; acá, 256 y hoy nada se acerca).
  const opciones = (saliente.opciones ?? []).filter(
    (o) => Buffer.byteLength(o.id, "utf8") <= MAX_ID_BYTES,
  );

  if (opciones.length === 0) {
    return partirTexto(saliente.texto, MAX_TEXTO).map((texto) => ({ tipo: "texto", texto }));
  }

  const { preludios, body } = partirCuerpoInteractivo(saliente.texto);
  const previos: EnvioWhatsApp[] = preludios.map((texto) => ({ tipo: "texto", texto }));

  if (opciones.length <= MAX_BOTONES) {
    return [...previos, { tipo: "botones", texto: body, botones: titulosDeBotones(opciones) }];
  }

  if (opciones.length <= MAX_FILAS) {
    return [
      ...previos,
      {
        tipo: "lista",
        texto: body,
        boton: BOTON_LISTA,
        filas: opciones.map((o) => ({ id: o.id, ...partirEtiqueta(o.etiqueta) })),
      },
    ];
  }

  // Más de 10 opciones: no existe hoy, pero la red de seguridad es degradar a
  // texto numerado — el DOMINIO resuelve el número escrito (numeroDeOpcion),
  // el adaptador no traduce nada.
  const numerado = `${saliente.texto}\n\n${opciones
    .map((o, i) => `${i + 1}. ${o.etiqueta}`)
    .join("\n")}`;
  return partirTexto(numerado, MAX_TEXTO).map((texto) => ({ tipo: "texto", texto }));
}
