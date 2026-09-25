"use client";

import { Fragment, useMemo, useState } from "react";
import {
  fechaCorta,
  ORIGENES_RESPUESTA,
  recortarTexto,
  type Conversacion,
} from "@/lib/tipos";
import { Charla } from "./Charla";

/**
 * Una fila por PREGUNTA, y la charla entera desplegada adentro de la fila.
 *
 * ANTES ERAN DOS PANTALLAS. «Interacciones» listaba una fila por consulta y
 * «Conversaciones» una fila por charla. La división tenía una lógica —una
 * contesta «¿qué me preguntan?» y la otra «¿cómo le fue a esta persona?»— pero
 * en la práctica las dos listas mostraban los mismos hechos con distinto
 * agrupamiento, y para contestar cualquier pregunta real había que ir a las dos:
 * la consulta estaba en una y el voto del vecino en la otra.
 *
 * Quedó una sola, y la unidad es la CONSULTA, no la charla. Motivo: la lista de
 * consultas reales, ordenada por hora, es lo más parecido que hay a escuchar la
 * mesa de entrada, y es la que dice qué conocimiento falta cargar. Agrupando por
 * charla eso se pierde: una conversación con seis preguntas aparecía como una
 * sola fila, con la primera.
 *
 * Lo que aportaba Conversaciones —cómo le fue, el voto, lo que el vecino dijo
 * que le faltaba— no se perdió: está en la cabecera del desplegado, que es donde
 * corresponde, porque es de la charla y no de la consulta.
 *
 * CÓMO SE ARMA CADA FILA. La pregunta es un mensaje ENTRANTE y la respuesta es
 * el saliente que vino después en la misma conversación. La traza —qué intención
 * se le leyó y de dónde salió la respuesta— viaja en el SALIENTE, no en el
 * entrante, así que hay que emparejarlos. Se empareja acá y no en SQL por lo
 * mismo que el tablero: los agregados de PostgREST están deshabilitados en este
 * proyecto y `LIMITE_FILAS` acota cuántas filas entran.
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
interface Interaccion {
  id: string;
  conversacionId: string;
  cuando: string;
  vecino: string | null;
  canal: string;
  consulta: string;
  esMedia: boolean;
  intencion: string | null;
  origen: string | null;
  /** El bot no contestó nada a esta consulta. */
  sinRespuesta: boolean;
  /**
   * Acá algo salió mal: o no hubo respuesta, o el bot admitió que no sabía, o el
   * vecino votó que no le sirvió en algún momento de esa charla.
   *
   * Las dos primeras son de la consulta y la tercera es de la conversación, y se
   * mezclan a propósito: el filtro que usa esto es la lista de trabajo —«qué
   * tengo que arreglar»—, y para eso no importa a qué nivel está registrada la
   * falla. Lo que sí importa es no perderla.
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

function arma(
  mensajes: readonly MensajeDeLista[],
  conversaciones: readonly Conversacion[],
): Interaccion[] {
  const porConversacion = new Map(conversaciones.map((c) => [c.id, c]));

  // Los mensajes vienen del más nuevo al más viejo. Para emparejar cada
  // pregunta con la respuesta que le siguió hay que recorrerlos en el orden en
  // que ocurrieron.
  const enOrden = [...mensajes].sort((a, b) => a.creado_en.localeCompare(b.creado_en));

  const salidas: Interaccion[] = [];
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

    const conversacion = porConversacion.get(m.conversacion_id);
    const texto = (m.texto ?? "").trim();
    const origen = respuesta?.origen_respuesta ?? null;
    const sinRespuesta = respuesta === null;

    salidas.push({
      id: m.id,
      conversacionId: m.conversacion_id,
      cuando: m.creado_en,
      vecino: conversacion?.nombre_usuario ?? null,
      canal: conversacion?.canal ?? "telegram",
      // Un toque de botón llega sin texto. Decir «(sin texto)» sería mentir por
      // omisión: el vecino hizo algo, y lo que hizo fue tocar una opción.
      consulta: texto !== "" ? texto : m.media_tipo !== null ? `envió ${m.media_tipo}` : "tocó una opción",
      esMedia: texto === "" && m.media_tipo !== null,
      intencion: respuesta?.intencion ?? null,
      origen,
      sinRespuesta,
      fallo: sinRespuesta || origen === "fallback" || (conversacion?.votos_no_utiles ?? 0) > 0,
    });
  }

  return salidas.reverse();
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

  const todas = useMemo(() => arma(mensajes, conversaciones), [mensajes, conversaciones]);
  const porConversacion = useMemo(
    () => new Map(conversaciones.map((c) => [c.id, c])),
    [conversaciones],
  );

  // Qué consulta está desplegada, por id del mensaje entrante. Es por CONSULTA y
  // no por charla: una conversación larga aparece en varias filas, y desplegar
  // «la charla» abriría todas esas filas a la vez.
  //
  // Estado inicial perezoso: la búsqueda del enlace corre una sola vez, no en
  // cada render. Si no hay fila para esa charla —una vieja, que ya no entra en
  // las que se traen— queda en null y más abajo se despliega igual, suelta.
  const [abierta, setAbierta] = useState<string | null>(
    () =>
      abrirConversacion === undefined
        ? null
        : (todas.find((i) => i.conversacionId === abrirConversacion)?.id ?? null),
  );

  const intenciones = useMemo(() => {
    const cuenta = new Map<string, number>();
    for (const i of todas) {
      if (i.intencion === null) continue;
      cuenta.set(i.intencion, (cuenta.get(i.intencion) ?? 0) + 1);
    }
    return [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
  }, [todas]);

  const conFallas = useMemo(() => todas.filter((i) => i.fallo).length, [todas]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return todas.filter((i) => {
      if (soloFallas && !i.fallo) return false;
      if (intencion !== null && i.intencion !== intencion) return false;
      if (origen !== null && i.origen !== origen) return false;
      // Las fechas del filtro son días locales; se comparan contra el día del
      // mensaje, no contra el instante, para que «desde el 28» incluya al 28.
      const dia = i.cuando.slice(0, 10);
      if (desde !== "" && dia < desde) return false;
      if (hasta !== "" && dia > hasta) return false;
      if (q === "") return true;
      return i.consulta.toLowerCase().includes(q) || (i.vecino ?? "").toLowerCase().includes(q);
    });
  }, [todas, busqueda, intencion, origen, soloFallas, desde, hasta]);

  const hayFiltro =
    busqueda !== "" ||
    intencion !== null ||
    origen !== null ||
    soloFallas ||
    desde !== "" ||
    hasta !== "";

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

  // El enlace apuntaba a una charla que no tiene ninguna fila en la lista. Se
  // muestra suelta arriba: el que hizo clic en Clima venía a leer ESA charla, y
  // una pantalla que no le muestra nada lo deja sin saber si el enlace está roto
  // o si la charla no existe.
  const sueltaId =
    abrirConversacion !== undefined && !todas.some((i) => i.conversacionId === abrirConversacion)
      ? abrirConversacion
      : null;
  const suelta = sueltaId === null ? null : (porConversacion.get(sueltaId) ?? null);

  return (
    <>
      <div className="resumen">
        <div>
          <span className="n">{todas.length}</span>
          <span className="r">consultas</span>
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
          placeholder="Buscar en las consultas…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          aria-label="Buscar en las consultas"
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
          {visibles.length === todas.length
            ? `${todas.length} consultas`
            : `${visibles.length} de ${todas.length}`}
        </span>
      </div>

      {alcanzoElLimite && (
        <div className="aviso info">
          Se están mostrando las consultas más recientes, no todas las que hubo. Para el total,
          mirá Métricas.
        </div>
      )}

      {suelta && (
        <div className="tarjeta" style={{ padding: 16, marginBottom: 16 }}>
          <div className="aviso info">
            Esta charla no tiene ninguna consulta entre las más recientes, así que va suelta acá.
          </div>
          <Charla conversacion={suelta} />
        </div>
      )}

      {visibles.length === 0 ? (
        <div className="tarjeta vacio">
          {todas.length === 0
            ? "Todavía no hay consultas. Aparecen acá apenas alguien le escriba a Migue."
            : soloFallas
              ? "No hay ninguna consulta donde Migue haya fallado. Buena señal."
              : "Ninguna consulta coincide con lo que buscaste."}
        </div>
      ) : (
        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Vecino</th>
                <th>Qué preguntó</th>
                <th>Intención</th>
                <th>Respuesta</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((i) => {
                const conversacion = porConversacion.get(i.conversacionId) ?? null;
                const desplegada = abierta === i.id;
                return (
                  <Fragment key={i.id}>
                    <tr className={desplegada ? "fila-abierta" : undefined}>
                      <td className="num" style={{ whiteSpace: "nowrap" }}>
                        {fechaCorta(i.cuando)}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{i.vecino ?? "—"}</td>
                      <td style={{ maxWidth: 380 }}>
                        {conversacion === null ? (
                          <span className={i.esMedia ? "sub-fila" : undefined}>
                            {recortarTexto(i.consulta, 120)}
                          </span>
                        ) : (
                          <button
                            className="enlace-tabla"
                            onClick={() => setAbierta(desplegada ? null : i.id)}
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
                            {recortarTexto(i.consulta, 120)}
                          </button>
                        )}
                      </td>
                      <td>
                        {i.intencion === null ? (
                          <span className="sub-fila">—</span>
                        ) : (
                          <span className="chip">
                            {NOMBRE_DE_INTENCION[i.intencion] ?? i.intencion}
                          </span>
                        )}
                      </td>
                      <td>
                        {i.sinRespuesta ? (
                          <span className="chip alerta">se quedó sin respuesta</span>
                        ) : i.origen === null ? (
                          <span className="sub-fila">—</span>
                        ) : (
                          <span className={`chip ${i.origen === "fallback" ? "alerta" : "ok"}`}>
                            {ORIGENES_RESPUESTA[i.origen] ?? i.origen}
                          </span>
                        )}
                      </td>
                    </tr>

                    {desplegada && conversacion !== null && (
                      <tr className="fila-desplegada">
                        <td colSpan={5}>
                          <Charla conversacion={conversacion} resaltar={i.id} />
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
