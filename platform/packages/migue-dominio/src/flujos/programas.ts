/**
 * FLUJO C · Programas ambientales
 *
 * Tres flujos separados en lugar de un submenú con ramas, porque cada programa
 * pide datos distintos y mezclarlos en una máquina de estados con condicionales
 * la vuelve ilegible.
 *
 *   programa_educa      talleres y visitas: institución, responsable, alumnos
 *   programa_transforma murales y carteles: dirección y fotos de relevamiento
 *   programa_separa     sólo el caso FUERA de las 4 avenidas (ver abajo)
 *
 * SEPARÁ merece una aclaración. La spec lo trata como información, y así se
 * responde en la mayoría de los casos: el servicio pasa miércoles y sábados de
 * 09 a 12 dentro de las 4 avenidas. Pero el documento de QA agrega un caso que
 * la spec no contempla: para los domicilios FUERA de las avenidas el recorrido
 * no llega, y el área pidió expresamente capturar «nombre, teléfono, dirección
 * exacta, foto de los reciclados limpios, enunciarlos, y la franja horaria».
 *
 * Cómo se determina si está dentro o fuera: SE LE PREGUNTA. Decidirlo desde la
 * dirección requeriría el polígono de las cuatro avenidas y geocodificación, y
 * no tenemos ninguno de los dos. Una pregunta cerrada de una sola línea es
 * honesta; inventar una respuesta geográfica sería peor que preguntar.
 *
 * Y siguiendo la crítica central del QA, la información va PRIMERO: el vecino
 * recibe los días y horarios antes de que se le pregunte nada.
 */
import { palabraANumero } from "../reglas/cantidad.ts";
import {
  formatearDireccion,
  buscarDireccion,
  preguntaPorDireccion,
} from "../reglas/direccion.ts";
import { leerTexto, tieneTexto } from "../datos/catalogo.ts";
import { normalizar, recortar } from "../texto.ts";
import { decir, preguntar, textoEfectivo } from "../mensajeria.ts";
import type {
  DatosFlujo,
  DatosSolicitudPrograma,
  DefinicionFlujo,
  DefinicionPaso,
  Efecto,
  Transicion,
} from "./tipos.ts";

// ---------------------------------------------------------------------------
// Extracción de datos del texto libre
// ---------------------------------------------------------------------------

/**
 * Nombre de la institución.
 *
 * Busca una palabra clave de tipo de establecimiento y se queda con lo que
 * sigue, hasta una coma o cinco palabras. No es exhaustivo y no pretende
 * serlo: la spec dice «tomar datos en texto plano y enviar por mail a
 * administración», así que el texto completo se guarda igual y esto es sólo
 * para que el panel muestre algo útil en la columna.
 */
function extraerInstitucion(texto: string): string | null {
  const patron =
    /\b(escuela|colegio|jard[ií]n|instituto|liceo|universidad|facultad|centro)\b\s+([^,.;\n]{2,60})/iu;
  const m = patron.exec(texto);
  if (!m) return null;
  const cola = m[2]!.trim().split(/\s+/).slice(0, 5).join(" ");
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${cola}`.trim();
}

/** Cantidad de alumnos: número pegado a la palabra que lo nombra. */
function extraerAlumnos(texto: string): number | null {
  const patron = /([\wáéíóúñ]+)\s+(alumnos?|chicos?|chic[ao]s|estudiantes?|ni[ñn]os?)\b/giu;
  for (const m of texto.matchAll(patron)) {
    const n = palabraANumero(m[1]!);
    if (n !== null && n >= 1 && n <= 2000) return Math.round(n);
  }
  return null;
}

/**
 * Palabras que siguen a «responsable» sin nombrar a una persona.
 *
 * «El responsable de la limpieza» nombra un área. Y las conjunciones cortan la
 * frase: sin ellas, «responsable Ana y 30 chicos» daba «Ana y». Esa columna es
 * con la que el área llama por teléfono a alguien.
 */
const NO_ES_PERSONA = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una",
  "limpieza", "area", "zona", "turno", "obra", "grupo", "curso", "sector",
  "servicio", "programa", "proyecto", "todavia", "aun", "nadie",
]);

/** Dónde termina un nombre propio dentro de un mensaje con varios datos. */
const CORTA_EL_NOMBRE = new Set([
  "y", "e", "pero", "que", "con", "para", "porque", "aunque",
  "alumnos", "alumno", "chicos", "chicas", "estudiantes", "ninos", "ninas",
  "tel", "telefono", "cel", "celular", "whatsapp", "wsp", "contacto",
  "direccion", "calle", "altura", "mail", "email", "dni", "horario",
]);

/**
 * El responsable a cargo: «responsable Ramiro», «a cargo la seño Marta».
 *
 * ES LA FUNCIÓN QUE FALTABA. `educa_requisitos` pide este dato desde la
 * migración 008 y no existía en todo el repositorio nada que lo leyera, así que
 * `registros.ts` escribía su default y el 100% de las solicitudes quedaban con
 * «No especificado»: un dato perdido con la misma cara que un dato no dado.
 *
 * Devuelve `null` ante la duda. Un nombre inventado en esa columna es peor que
 * la columna vacía: alguien lo va a leer para llamar por teléfono.
 */
function extraerResponsable(texto: string): string | null {
  const patron =
    /\b(responsable|a cargo|referente|docente|director[ae]?|directora|se[\u00f1n]o(?:ra)?|profe(?:sora?)?)\b\s*:?\s*(?:es\s+|la\s+|el\s+)?([^,.;\n]{2,40})/iu;
  const m = patron.exec(texto);
  if (!m) return null;

  const palabras: string[] = [];
  for (const palabra of m[2]!.trim().split(/\s+/)) {
    if (/\d/.test(palabra)) break;
    if (CORTA_EL_NOMBRE.has(normalizar(palabra))) break;
    palabras.push(palabra);
    if (palabras.length === 3) break;
  }

  if (palabras.length === 0) return null;
  if (NO_ES_PERSONA.has(normalizar(palabras[0]!))) return null;
  return palabras.join(" ");
}

/** Teléfono argentino escrito de cualquier forma. También lo usa pedirAsesor. */
export function extraerTelefono(texto: string): string | null {
  const m = /(?:\+?54\s?)?(?:9\s?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3}[\s-]?\d{4}\b/.exec(texto);
  if (!m) return null;
  const soloDigitos = m[0].replace(/\D/g, "");
  // Menos de 8 dígitos no es un teléfono; más de 13 tampoco.
  return soloDigitos.length >= 8 && soloDigitos.length <= 13 ? m[0].trim() : null;
}

/** Franja horaria declarada («de 9 a 12», «por la mañana»). */
function extraerFranja(texto: string): string | null {
  const rango = /\bde\s+(\d{1,2})(?::\d{2})?\s*(?:a|hasta)\s*(\d{1,2})(?::\d{2})?\s*(?:hs?)?\b/i.exec(texto);
  if (rango) return `de ${rango[1]} a ${rango[2]} hs`;
  const norm = normalizar(texto);
  for (const [clave, etiqueta] of [
    ["manana", "por la mañana"],
    ["tarde", "por la tarde"],
    ["mediodia", "al mediodía"],
    ["noche", "por la noche"],
  ] as const) {
    if (new RegExp(`(?<![\\p{L}])${clave}(?![\\p{L}])`, "u").test(norm)) return etiqueta;
  }
  return null;
}

function solicitud(
  programa: DatosSolicitudPrograma["programa"],
  parcial: Partial<DatosSolicitudPrograma> & { direccion: string },
): Efecto {
  return {
    tipo: "crear_solicitud_programa",
    datos: {
      programa,
      institucion: parcial.institucion ?? null,
      responsable: parcial.responsable ?? null,
      cantidadAlumnos: parcial.cantidadAlumnos ?? null,
      direccion: parcial.direccion,
      telefonoContacto: parcial.telefonoContacto ?? null,
      informacionAdicional: parcial.informacionAdicional ?? null,
      fotoReferencia: parcial.fotoReferencia ?? null,
    },
  };
}

/**
 * Paso genérico «pedir dirección y registrar».
 *
 * EDUCÁ y TRANSFORMÁ comparten la forma —un pedido de datos en texto libre del
 * que sólo la dirección es obligatoria— y sólo cambian en qué extraen y qué
 * mensaje cierran. Escribirlos dos veces garantizaría que se desincronicen.
 */
function pasoDeSolicitud(opciones: {
  readonly claveTextoApertura: string;
  readonly programa: DatosSolicitudPrograma["programa"];
  readonly pideFoto: boolean;
  readonly cierre: string;
}): DefinicionPaso {
  return {
    abrir: (ctx) => [decir(leerTexto(ctx.catalogo, opciones.claveTextoApertura), "texto")],
    maxIntentos: 3,
    procesar: (_ctx, datos, entrante): Transicion => {
      const texto = textoEfectivo(entrante);
      const previo = datos as { texto?: string; fotoReferencia?: string | null };

      const foto = entrante.media?.tipo === "imagen" ? entrante.media.referencia : null;
      const fotoReferencia = foto ?? previo.fotoReferencia ?? null;

      // Se acumula el texto de todos los turnos: el vecino puede dar la
      // institución en un mensaje y la dirección en el siguiente.
      const acumulado = [previo.texto, texto].filter(Boolean).join(" · ");
      const direccion = buscarDireccion(texto);

      if (!direccion.completa) {
        const pregunta =
          texto === "" && foto !== null
            ? "Recibí la foto. Ahora necesito la dirección exacta: calle y altura."
            : (preguntaPorDireccion(direccion) ?? "Necesito la dirección exacta.");
        return {
          tipo: "repetir",
          datos: { texto: acumulado, fotoReferencia },
          mensaje: decir(pregunta, "texto"),
        };
      }

      const efectos: Efecto[] = [
        solicitud(opciones.programa, {
          direccion: formatearDireccion(direccion),
          institucion: extraerInstitucion(acumulado),
          responsable: extraerResponsable(acumulado),
          cantidadAlumnos: extraerAlumnos(acumulado),
          telefonoContacto: extraerTelefono(acumulado),
          informacionAdicional: recortar(acumulado, 1000),
          fotoReferencia,
        }),
      ];
      if (fotoReferencia !== null) {
        efectos.push({
          tipo: "guardar_media",
          referencia: fotoReferencia,
          proposito: `programa_${opciones.programa}`,
        });
      }

      const cierre =
        opciones.pideFoto && fotoReferencia === null
          ? `${opciones.cierre} Si podés, mandanos después una foto de la zona: ayuda al relevamiento.`
          : opciones.cierre;

      return { tipo: "terminar", mensajes: [decir(cierre, "nada")], efectos };
    },
  };
}

// ---------------------------------------------------------------------------
// EDUCÁ · talleres y visitas
// ---------------------------------------------------------------------------

export const flujoProgramaEduca: DefinicionFlujo = {
  nombre: "programa_educa",
  pasoInicial: "datos",
  pasos: {
    datos: pasoDeSolicitud({
      claveTextoApertura: "educa_requisitos",
      programa: "educa",
      pideFoto: false,
      cierre:
        "✅ Listo, registré la solicitud del programa EDUCÁ. El equipo se va a contactar con la institución para coordinar la visita.",
    }),
  },
};

// ---------------------------------------------------------------------------
// TRANSFORMÁ · murales y carteles
// ---------------------------------------------------------------------------

export const flujoProgramaTransforma: DefinicionFlujo = {
  nombre: "programa_transforma",
  pasoInicial: "datos",
  pasos: {
    datos: pasoDeSolicitud({
      claveTextoApertura: "transforma_requisitos",
      programa: "transforma",
      pideFoto: true,
      cierre:
        "✅ Listo, registré el pedido del programa TRANSFORMÁ. Un equipo va a hacer el relevamiento de la zona.",
    }),
  },
};

// ---------------------------------------------------------------------------
// SEPARÁ · información primero, y datos sólo si está fuera de las avenidas
// ---------------------------------------------------------------------------

export const flujoProgramaSepara: DefinicionFlujo = {
  nombre: "programa_separa",
  pasoInicial: "cobertura",

  pasos: {
    cobertura: {
      // La información va PRIMERO, antes de cualquier pregunta. Es la crítica
      // central del QA: «yo mandaría primero la respuesta y si le quedan dudas
      // seguir».
      abrir: (ctx) => [
        decir(leerTexto(ctx.catalogo, "separa_info"), "nada"),
        preguntar("Para confirmar si el recorrido llega a tu casa: ¿tu domicilio está dentro de las 4 avenidas?", [
          { id: "dentro", etiqueta: "Sí, dentro de las 4 avenidas" },
          { id: "fuera", etiqueta: "No, fuera de las avenidas" },
          { id: "no_se", etiqueta: "No estoy seguro" },
        ]),
      ],

      procesar: (ctx, _datos, entrante): Transicion => {
        const respuesta = entrante.seleccion ?? normalizar(textoEfectivo(entrante));

        const esDentro = respuesta === "dentro" || /\b(si|dentro|adentro)\b/.test(respuesta);
        const esFuera = respuesta === "fuera" || /\b(no|fuera|afuera)\b/.test(respuesta);

        if (esDentro) {
          return {
            tipo: "terminar",
            mensajes: [
              decir(
                "Perfecto, entonces el recorrido pasa por tu casa. Dejá los reciclables limpios y secos en la vereda el día que corresponde.",
                "nada",
              ),
            ],
          };
        }

        if (esFuera) {
          return { tipo: "avanzar", a: "datos_fuera" };
        }

        // «No estoy seguro» no es un fracaso del vecino: no tiene por qué saber
        // dónde termina un límite administrativo. Se toma el camino seguro —
        // pedir los datos— en lugar de insistir con la pregunta.
        return {
          tipo: "avanzar",
          a: "datos_fuera",
          mensajes: [
            decir(
              "No hay problema. Tomo tus datos y el equipo confirma si el recorrido llega o si hay que coordinar un retiro.",
              "nada",
            ),
          ],
        };
      },
    },

    datos_fuera: {
      // Los datos que pidió el área en el documento de QA, en un solo mensaje.
      //
      // SALE DEL CATÁLOGO, y eso es un arreglo. La clave
      // `separa_fuera_de_avenidas` existe en `textos_bot` desde la migración 008,
      // con el texto que el área pidió explícitamente — y NINGÚN archivo la leía.
      // El bot mandaba la versión escrita a mano acá abajo. O sea: el panel
      // ofrecía editar esta frase, confirmaba que se había guardado, y el vecino
      // seguía recibiendo otra cosa. Es la peor clase de control roto, porque no
      // parece roto.
      //
      // El texto de abajo queda como RESPALDO: la clave está marcada `opcional`,
      // así que se puede vaciar desde el panel, y este paso no puede quedarse sin
      // pedir los datos o el flujo se corta con el vecino esperando.
      abrir: (ctx) => [
        decir(
          tieneTexto(ctx.catalogo, "separa_fuera_de_avenidas")
            ? leerTexto(ctx.catalogo, "separa_fuera_de_avenidas")
            : "Para coordinar el retiro necesito, en un mismo mensaje:\n\n" +
              "• Tu nombre\n" +
              "• Un teléfono de contacto\n" +
              "• La dirección exacta (calle y altura)\n" +
              "• Qué materiales tenés para entregar\n" +
              "• En qué franja horaria estás\n\n" +
              "Si podés sumar una foto de los reciclables limpios, mejor.",
          "texto",
        ),
      ],
      maxIntentos: 3,

      procesar: (_ctx, datos, entrante): Transicion => {
        const texto = textoEfectivo(entrante);
        const previo = datos as { texto?: string; fotoReferencia?: string | null };

        const foto = entrante.media?.tipo === "imagen" ? entrante.media.referencia : null;
        const fotoReferencia = foto ?? previo.fotoReferencia ?? null;
        const acumulado = [previo.texto, texto].filter(Boolean).join(" · ");

        const direccion = buscarDireccion(texto);
        if (!direccion.completa) {
          return {
            tipo: "repetir",
            datos: { texto: acumulado, fotoReferencia },
            mensaje: decir(
              preguntaPorDireccion(direccion) ??
                "Me falta la dirección exacta: calle y altura.",
              "texto",
            ),
          };
        }

        const efectos: Efecto[] = [
          solicitud("separa", {
            direccion: formatearDireccion(direccion),
            telefonoContacto: extraerTelefono(acumulado),
            informacionAdicional: [
              extraerFranja(acumulado) ? `Franja: ${extraerFranja(acumulado)}` : null,
              recortar(acumulado, 900),
            ]
              .filter(Boolean)
              .join(" | "),
            fotoReferencia,
          }),
        ];
        if (fotoReferencia !== null) {
          efectos.push({
            tipo: "guardar_media",
            referencia: fotoReferencia,
            proposito: "programa_separa",
          });
        }

        return {
          tipo: "terminar",
          mensajes: [
            decir(
              "✅ Listo, pasé tu pedido al equipo del programa SEPARÁ para que coordinen el retiro con vos.",
              "nada",
            ),
          ],
          efectos,
        };
      },
    },
  },
};

/** Los tres flujos de programas, para registrarlos de una vez. */
export const flujosDeProgramas = [
  flujoProgramaEduca,
  flujoProgramaTransforma,
  flujoProgramaSepara,
] as const;
