"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  comoLeFue,
  fechaCorta,
  ORIGENES_RESPUESTA,
  recortarTexto,
  type Conversacion,
} from "@/lib/tipos";
import { Charla } from "./Charla";

/**
 * Una fila por VECINO, con la charla entera desplegada adentro de la fila.
 *
 * ANTES ERAN DOS PANTALLAS. «Interacciones» listaba una fila por consulta y
 * «Conversaciones» una fila por charla. La división tenía una lógica en el
 * papel —una contesta «¿qué me preguntan?» y la otra «¿cómo le fue a esta
 * persona?»— y ninguna en el uso: para entender un caso había que ir a las dos,
 * porque la consulta estaba en una y el voto del vecino en la otra.
 *
 * Y DESPUÉS LA UNIDAD CAMBIÓ. La primera versión unificada listaba una fila por
 * CONSULTA. Se probó con datos reales y el problema saltó enseguida: una charla
 * de seis preguntas ocupaba seis renglones, así que la pantalla era una lista
 * larguísima donde el mismo vecino aparecía una y otra vez y no se veía cuánta
 * gente había hablado. Ahora la fila es la CHARLA —el vecino— y muestra cómo
 * empezó; las preguntas de adentro se ven al desplegarla.
 *
 * LOS FILTROS SIGUEN SIENDO POR PREGUNTA, Y ESO ES LO QUE SALVA LA LISTA.
 * Agrupar por charla podría haber perdido lo que la lista de consultas servía:
 * saber qué se pregunta y qué no se supo contestar. No se perdió, porque filtrar
 * por intención, por origen o por texto sigue mirando CADA pregunta de adentro,
 * y la charla aparece si alguna coincide. Con un filtro puesto, la fila además
 * muestra cuál fue la pregunta que coincidió, así no hay que desplegar para
 * saber por qué está ahí.
 *
 * CÓMO SE ARMA CADA CONSULTA. La pregunta es un mensaje ENTRANTE y la respuesta
 * es el saliente que vino después en la misma conversación. La traza —qué
 * intención se le leyó y de dónde salió la respuesta— viaja en el SALIENTE, no
 * en el entrante, así que hay que emparejarlos. Se empareja acá y no en SQL por
 * lo mismo que el tablero: los agregados de PostgREST están deshabilitados en
 * este proyecto y `LIMITE_FILAS` acota cuántas filas entran.
 *
 * LO QUE NO ESTÁ, Y ES A PROPÓSITO. El panel de referencia muestra el teléfono
 * del turista en cada fila. Acá no: en WhatsApp `canal_usuario_id` ES el teléfono
 * del vecino, y la migración 023 lo sacó de la vista justamente para que no
 * viajara a cada navegador que abre una lista. Se reconoce al vecino por el
 * nombre, y quien necesite más despliega la charla.
 */

export interface MensajeDeLista {
  id: string;
  conversacion_id: string;
  direccion: "entrante" | "saliente";
  texto: string | null;
  media_tipo: string | null;
  intencion: string | null;
  origen_respuesta: string | null;
  creado_en: string;
}

/** Una consulta del vecino, con lo que se sabe de la respuesta que recibió. */
interface Consulta {
  id: string;
  conversacionId: string;
  cuando: string;
  consulta: string;
  intencion: string | null;
  origen: string | null;
  /** El bot no contestó nada a esta consulta. */
  sinRespuesta: boolean;
}

/** Una charla, que es lo que ocupa una fila: un vecino y todo lo que preguntó. */
interface Hilo {
  conversacion: Conversacion;
  /** Las preguntas de esa charla, de la más vieja a la más nueva. */
  consultas: Consulta[];
  /** Cómo arrancó: lo primero que escribió el vecino. */
  inicio: string;
  /**
   * Acá hay algo QUE HACER: el vecino votó que no le sirvió, o quedó una
   * pregunta sin responder, o una consulta no recibió ninguna respuesta.
   *
   * NO entra el «no supo» (`origen_respuesta = 'fallback'`), y la ausencia es
   * lo más importante de este campo. Cuando el bot no sabe, el orquestador
   * escribe DOS cosas a la vez: el saliente con origen `fallback` y una fila en
   * `sin_respuesta` (orquestador.ts:761). Son el mismo hecho contado dos veces.
   * La fila de `sin_respuesta` se resuelve —el área escribe la respuesta y
   * `preguntas_pendientes` baja—; el mensaje viejo con origen `fallback` se
   * queda ahí para siempre. Contar el fallback hacía que este número fuera
   * monótono creciente: hacer el trabajo no lo bajaba nunca.
   *
   * Es exactamente el bug que ya tuvo esta pantalla con
   * `preguntas_sin_responder` y que arregló la columna `preguntas_pendientes`.
   * Medido en produccion el 2026-09-25: 3 consultas con fallback, 0 pendientes
   * —porque ya se despacharon—, 2 charlas con voto negativo. Lo honesto es 2;
   * contando el fallback daban 5.
   *
   * El «no supo» no se pierde: sigue en el filtro de origen, que es donde
   * corresponde, porque es historia y no tarea.
   */
  fallo: boolean;
}

/**
 * Cómo se nombra cada intención en pantalla.
 *
 * Tiene que cubrir todo lo que se escribe en `mensajes.intencion`, que es más
 * que lo que devuelve el router. Las fuentes, todas las que hay:
 *
 *   la intención del clasificador          orquestador.ts:546 y :809
 *   el nombre del flujo activo             orquestador.ts:471
 *   la opción del menú que se tocó         orquestador.ts:528
 *   `voto_<voto>`, con los pulgares        orquestador.ts:346
 *   `derivada_a_migue`                     orquestador.ts:971
 *   `encuesta_cierre`                      encuestaCierre.ts:50
 *
 * Faltaban cinco, y el área los veía en crudo entre los nombres legibles: ids
 * internos asomando a la superficie, la misma clase de fuga que el
 * `consulta_libre` que le llegaba al vecino. `encuesta_cierre` es la que más
 * fácil se escapa porque no la escribe el orquestador.
 *
 * Hay una fuente MÁS que no va acá, y es el motivo del `??` en el uso: cuando
 * corta una regla de exclusión, la intención es el NOMBRE de la regla —«Fuga de
 * gas»—, que ya está escrito para leerse y lo edita el área desde Reglas.
 * Mapearlo exigiría mantener acá una copia de una tabla.
 */
const NOMBRE_DE_INTENCION: Readonly<Record<string, string>> = {
  retiro_no_habitual: "retiro",
  reclamo_recoleccion: "reclamo",
  programa_educa: "EDUCÁ",
  programa_transforma: "TRANSFORMÁ",
  programa_separa: "SEPARÁ",
  consulta_libre: "consulta",
  pedir_asesor: "pidió una persona",
  saludo: "saludo",
  despedida: "despedida",
  fuera_de_alcance: "fuera de alcance",
  no_entendido: "no entendido",
  derivada_a_migue: "derivada a Migue",
  voto_util: "voto: le sirvió",
  voto_no_util: "voto: no le sirvió",
  encuesta_cierre: "encuesta de cierre",
};

/** Empareja cada pregunta con la respuesta que le siguió. */
function consultasDe(mensajes: readonly MensajeDeLista[]): Consulta[] {
  // Los mensajes vienen del más nuevo al más viejo. Para emparejar cada
  // pregunta con la respuesta que le siguió hay que recorrerlos en el orden en
  // que ocurrieron.
  const enOrden = [...mensajes].sort((a, b) => a.creado_en.localeCompare(b.creado_en));

  const salidas: Consulta[] = [];
  for (let i = 0; i < enOrden.length; i++) {
    const m = enOrden[i]!;
    if (m.direccion !== "entrante") continue;

    // El primer saliente de la MISMA conversación que vino después. Si el
    // siguiente entrante llega antes, esa consulta se quedó sin respuesta.
    let respuesta: MensajeDeLista | null = null;
    for (let j = i + 1; j < enOrden.length; j++) {
      const siguiente = enOrden[j]!;
      if (siguiente.conversacion_id !== m.conversacion_id) continue;
      if (siguiente.direccion === "entrante") break;
      respuesta = siguiente;
      break;
    }

    const texto = (m.texto ?? "").trim();

    salidas.push({
      id: m.id,
      conversacionId: m.conversacion_id,
      cuando: m.creado_en,
      // Un toque de botón llega sin texto. Decir «(sin texto)» sería mentir por
      // omisión: el vecino hizo algo, y lo que hizo fue tocar una opción.
      consulta:
        texto !== "" ? texto : m.media_tipo !== null ? `envió ${m.media_tipo}` : "tocó una opción",
      intencion: respuesta?.intencion ?? null,
      origen: respuesta?.origen_respuesta ?? null,
      sinRespuesta: respuesta === null,
    });
  }

  return salidas;
}

/** Una fila por charla, con sus consultas adentro. */
function agrupar(
  mensajes: readonly MensajeDeLista[],
  conversaciones: readonly Conversacion[],
): Hilo[] {
  const porConversacion = new Map<string, Consulta[]>();
  for (const c of consultasDe(mensajes)) {
    const lista = porConversacion.get(c.conversacionId);
    if (lista) lista.push(c);
    else porConversacion.set(c.conversacionId, [c]);
  }

  // La lista sale de CONVERSACIONES y no de los mensajes: así una charla vieja
  // —cuyos mensajes ya no entran en las filas que se traen— aparece igual, con
  // su primer mensaje, en vez de desaparecer de la pantalla.
  return conversaciones.map((conversacion) => {
    const consultas = porConversacion.get(conversacion.id) ?? [];
    const primero = (conversacion.primer_mensaje ?? "").trim();
    const inicio = primero !== "" ? primero : (consultas[0]?.consulta ?? "(sin texto)");

    return {
      conversacion,
      consultas,
      inicio,
      fallo:
        conversacion.votos_no_utiles > 0 ||
        conversacion.preguntas_pendientes > 0 ||
        consultas.some((c) => c.sinRespuesta),
    };
  });
}

export function Interacciones({
  mensajes,
  conversaciones,
  alcanzoElLimite,
  abrirConversacion,
}: {
  mensajes: MensajeDeLista[];
  conversaciones: Conversacion[];
  alcanzoElLimite: boolean;
  /**
   * Qué charla desplegar de entrada. Viene de Clima y de Alertas: desde un
   * pulgar abajo se llega acá para leer el ida y vuelta completo, y hacer buscar
   * la fila a mano anularía la mitad del sentido del enlace.
   *
   * Lo resuelve el SERVIDOR y llega como prop, en vez de leerlo acá con
   * `useSearchParams`. Ese hook obliga a envolver el componente en un
   * `<Suspense>` y a que la página se renderice en el cliente; el parámetro ya
   * lo tiene la página, que es un server component.
   */
  abrirConversacion?: string | undefined;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [intencion, setIntencion] = useState<string | null>(null);
  const [origen, setOrigen] = useState<string | null>(null);
  const [soloFallas, setSoloFallas] = useState(false);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  // Qué charla está desplegada, por id de conversación. Una sola a la vez: son
  // charlas largas, y dos abiertas dejan la lista imposible de barrer.
  const [abierta, setAbierta] = useState<string | null>(abrirConversacion ?? null);

  // El enlace de Clima y de Alertas trae la vista hasta la charla, no alcanza
  // con desplegarla.
  //
  // Antes esto no hacia falta: `?abrir=` levantaba un cajon `position: fixed`,
  // que aparecia encima de todo estuviera donde estuviera la fila. Ahora la
  // charla se despliega DENTRO de la tabla, la pagina carga arriba de todo, y
  // la fila puede estar cincuenta renglones mas abajo. El del area hacia clic
  // en «Ver la charla entera», veia una pantalla igual a cualquier otra, y
  // concluia que el boton estaba roto. Lo encontro una revision del cambio, no
  // una prueba: compila igual y se ve bien en una lista de tres filas.
  //
  // Corre una sola vez, al llegar por el enlace, y no en cada clic: que la
  // pantalla se mueva sola cuando uno despliega una fila que ya esta mirando es
  // peor que no moverse.
  //
  // Sin animacion: de la fila 1 a la 300 un desplazamiento suave es un viaje
  // largo y mareador. `center` deja la fila en el medio, asi se ve la charla y
  // tambien las filas de alrededor, que es lo que dice donde esta uno parado.
  useEffect(() => {
    if (abrirConversacion === undefined || abrirConversacion === "") return;
    const fila = document.getElementById(`charla-${abrirConversacion}`);
    if (fila === null) return;
    fila.scrollIntoView({ block: "center" });
  }, [abrirConversacion]);

  const hilos = useMemo(() => agrupar(mensajes, conversaciones), [mensajes, conversaciones]);
  const totalConsultas = useMemo(
    () => hilos.reduce((n, h) => n + h.consultas.length, 0),
    [hilos],
  );

  const intenciones = useMemo(() => {
    const cuenta = new Map<string, number>();
    for (const h of hilos) {
      for (const c of h.consultas) {
        if (c.intencion === null) continue;
        cuenta.set(c.intencion, (cuenta.get(c.intencion) ?? 0) + 1);
      }
    }
    return [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
  }, [hilos]);

  const conFallas = useMemo(() => hilos.filter((h) => h.fallo).length, [hilos]);

  /** Si hay un filtro de los que miran PREGUNTAS, cuáles coincidieron. */
  const hayFiltroDePregunta = busqueda.trim() !== "" || intencion !== null || origen !== null;

  const coincidenciasDe = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return (h: Hilo): Consulta[] => {
      if (!hayFiltroDePregunta) return [];
      return h.consultas.filter((c) => {
        if (intencion !== null && c.intencion !== intencion) return false;
        if (origen !== null && c.origen !== origen) return false;
        if (q !== "" && !c.consulta.toLowerCase().includes(q)) return false;
        return true;
      });
    };
  }, [busqueda, intencion, origen, hayFiltroDePregunta]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const filtradas = hilos.filter((h) => {
      if (soloFallas && !h.fallo) return false;

      // Las fechas del filtro son días locales; se comparan contra el día de la
      // última actividad de la charla, no contra el instante, para que «desde el
      // 28» incluya al 28.
      const dia = h.conversacion.ultima_actividad_en.slice(0, 10);
      if (desde !== "" && dia < desde) return false;
      if (hasta !== "" && dia > hasta) return false;

      // Los filtros de pregunta miran ADENTRO de la charla: alcanza con que una
      // coincida. Es lo que hace que agrupar por vecino no pierda la pregunta.
      if (intencion !== null || origen !== null) {
        if (coincidenciasDe(h).length === 0) return false;
      }

      if (q === "") return true;
      // El texto también busca por el nombre del vecino y por cómo empezó la
      // charla, no sólo en las preguntas: con el nombre es como el área busca a
      // alguien que llamó por teléfono.
      if ((h.conversacion.nombre_usuario ?? "").toLowerCase().includes(q)) return true;
      if (h.inicio.toLowerCase().includes(q)) return true;
      return coincidenciasDe(h).length > 0;
    });

    // Con el filtro de fallas puesto SÍ se reordena por gravedad: ahí la lista
    // deja de ser la bitácora y pasa a ser la lista de trabajo, y lo primero
    // que hay que ver es el pulgar abajo sobre una respuesta. Sin esto, una
    // charla de hace tres días con un voto negativo quedaba al final, debajo de
    // las de hoy que sólo tienen una pregunta pendiente.
    if (!soloFallas) return filtradas;
    return [...filtradas].sort(
      (a, b) => comoLeFue(a.conversacion).urgencia - comoLeFue(b.conversacion).urgencia,
    );
  }, [hilos, busqueda, intencion, origen, soloFallas, desde, hasta, coincidenciasDe]);

  const hayFiltro = hayFiltroDePregunta || soloFallas || desde !== "" || hasta !== "";

  function limpiar() {
    setBusqueda("");
    setIntencion(null);
    setOrigen(null);
    setSoloFallas(false);
    setDesde("");
    setHasta("");
  }

  const utiles = conversaciones.reduce((n, c) => n + c.votos_utiles, 0);
  const noUtiles = conversaciones.reduce((n, c) => n + c.votos_no_utiles, 0);
  const votos = utiles + noUtiles;

  return (
    <>
      <div className="resumen">
        <div>
          <span className="n">{hilos.length}</span>
          <span className="r">
            {hilos.length === 1 ? "charla" : "charlas"}, con {totalConsultas}{" "}
            {totalConsultas === 1 ? "consulta" : "consultas"}
          </span>
        </div>
        <div>
          <span className="n">
            {/*
              Con pocos votos un porcentaje es ruido: «100% útil» con un voto no
              dice nada y suena a que está medido. Debajo de diez se muestra el
              crudo, que es la verdad disponible.
            */}
            {votos === 0
              ? "—"
              : votos < 10
                ? `${utiles} de ${votos}`
                : `${Math.round((utiles / votos) * 100)}%`}
          </span>
          <span className="r">
            {votos === 0
              ? "todavía nadie votó"
              : votos < 10
                ? "votaron que les sirvió (son pocos votos para un porcentaje)"
                : "de los votos dijeron que sirvió"}
          </span>
        </div>
        <div>
          <span className="n" style={{ color: conFallas > 0 ? "var(--alerta)" : undefined }}>
            {conFallas}
          </span>
          <span className="r">donde algo falló</span>
        </div>
      </div>

      <div className="interacciones-filtros">
        <input
          type="search"
          className="buscador"
          placeholder="Buscar por vecino o por lo que preguntó…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          aria-label="Buscar por vecino o por lo que preguntó"
        />

        <select
          value={intencion ?? ""}
          onChange={(e) => setIntencion(e.target.value === "" ? null : e.target.value)}
          aria-label="Filtrar por intención"
        >
          <option value="">Todas las intenciones</option>
          {intenciones.map(([clave, n]) => (
            <option key={clave} value={clave}>
              {NOMBRE_DE_INTENCION[clave] ?? clave} ({n})
            </option>
          ))}
        </select>

        <select
          value={origen ?? ""}
          onChange={(e) => setOrigen(e.target.value === "" ? null : e.target.value)}
          aria-label="Filtrar por origen de la respuesta"
        >
          <option value="">Todos los orígenes</option>
          {Object.entries(ORIGENES_RESPUESTA).map(([clave, rotulo]) => (
            <option key={clave} value={clave}>
              {rotulo}
            </option>
          ))}
        </select>

        {/* La lista de trabajo. Era una pantalla entera —«Donde falló algo», en
            Conversaciones— y acá es un botón, porque es un recorte de esta misma
            lista y no otra cosa. */}
        <button
          className={soloFallas ? "primario chico" : "chico"}
          onClick={() => setSoloFallas((v) => !v)}
          aria-pressed={soloFallas}
        >
          Donde algo falló ({conFallas})
        </button>

        <label className="interacciones-fecha">
          Desde
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label className="interacciones-fecha">
          Hasta
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>

        {hayFiltro && (
          <button className="chico" onClick={limpiar}>
            Limpiar
          </button>
        )}

        <span className="interacciones-cuenta">
          {visibles.length === hilos.length
            ? `${hilos.length} ${hilos.length === 1 ? "charla" : "charlas"}`
            : `${visibles.length} de ${hilos.length}`}
        </span>
      </div>

      {alcanzoElLimite && (
        <div className="aviso info">
          Se están mostrando las charlas más recientes, no todas las que hubo. Para el total, mirá
          Métricas.
        </div>
      )}

      {visibles.length === 0 ? (
        <div className="tarjeta vacio">
          {hilos.length === 0
            ? "Todavía nadie habló con Migue. Cada vez que un vecino le escriba, la charla aparece acá."
            : soloFallas
              ? "No hay ninguna charla donde Migue haya fallado. Buena señal."
              : "Ninguna charla coincide con lo que buscaste."}
        </div>
      ) : (
        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Vecino</th>
                <th>Cómo empezó</th>
                <th className="num">Consultas</th>
                <th>Cómo le fue</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((h) => {
                const c = h.conversacion;
                const desplegada = abierta === c.id;
                const resultado = comoLeFue(c);
                const coincidencias = coincidenciasDe(h);
                return (
                  <Fragment key={c.id}>
                    <tr
                      id={`charla-${c.id}`}
                      className={desplegada ? "fila-abierta" : undefined}
                    >
                      <td className="num" style={{ whiteSpace: "nowrap" }}>
                        {fechaCorta(c.ultima_actividad_en)}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {c.nombre_usuario ?? "—"}
                        <div className="sub-fila">{c.canal}</div>
                      </td>
                      <td style={{ maxWidth: 380 }}>
                        <button
                          className="enlace-tabla"
                          onClick={() => setAbierta(desplegada ? null : c.id)}
                          aria-expanded={desplegada}
                          title={
                            desplegada
                              ? "Cerrar la charla"
                              : "Ver la charla completa y qué contestó Migue"
                          }
                        >
                          <span className="cursor-desplegar" aria-hidden="true">
                            {desplegada ? "▾" : "▸"}
                          </span>{" "}
                          {recortarTexto(h.inicio, 110)}
                        </button>

                        {c.flujo_activo && (
                          <div className="sub-fila">quedó a medias en {c.flujo_activo}</div>
                        )}

                        {/* Por qué esta charla pasó el filtro. Sin esto, filtrar
                            por «no supo» daba una lista de vecinos y había que
                            desplegar cada uno para ver cuál fue la pregunta. */}
                        {coincidencias.slice(0, 2).map((m) => (
                          <div key={m.id} className="sub-fila">
                            ↳ «{recortarTexto(m.consulta, 80)}»
                          </div>
                        ))}
                        {coincidencias.length > 2 && (
                          <div className="sub-fila">↳ y {coincidencias.length - 2} más</div>
                        )}
                      </td>
                      <td className="num">{h.consultas.length}</td>
                      <td>
                        <span className={`chip ${resultado.tono}`}>{resultado.etiqueta}</span>
                        {c.ultimo_comentario && (
                          // Lo que el vecino dijo que le faltaba. Se muestra en
                          // la LISTA y no sólo al desplegar: es la información
                          // más accionable de toda la pantalla, y esconderla
                          // detrás de un clic haría que casi nadie la lea.
                          <div className="detalle-problema">«{c.ultimo_comentario}»</div>
                        )}
                      </td>
                    </tr>

                    {desplegada && (
                      <tr className="fila-desplegada">
                        <td colSpan={5}>
                          <Charla
                            conversacion={c}
                            resaltar={coincidencias.length === 1 ? coincidencias[0]!.id : undefined}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
