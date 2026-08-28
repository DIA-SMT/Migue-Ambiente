"use client";

import { useMemo, useState } from "react";
import {
  fechaCorta,
  ORIGENES_RESPUESTA,
  recortarTexto,
  type Conversacion,
} from "@/lib/tipos";
import { Transcripcion } from "../conversaciones/Transcripcion";

/**
 * Una fila por PREGUNTA, no por conversación.
 *
 * POR QUÉ EXISTE, SI YA ESTÁ CONVERSACIONES. Son dos preguntas distintas y
 * ninguna de las dos se contesta bien con la lista de la otra:
 *
 *   Conversaciones  «¿cómo le fue a esta persona?» Una fila por charla, con el
 *                   voto y el estado. Sirve para entender un caso.
 *   Interacciones   «¿qué me están preguntando?» Una fila por consulta, con de
 *                   dónde salió la respuesta. Sirve para entender la demanda.
 *
 * La segunda es la que dice qué conocimiento falta cargar: una lista de
 * preguntas reales, ordenada por hora, es lo más parecido que hay a escuchar la
 * mesa de entrada. Conversaciones no sirve para eso porque agrupa: una charla
 * con seis preguntas aparece como una sola fila, con la primera.
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
 * nombre, y quien necesite más abre la conversación.
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
}

/** Cómo se nombra cada intención en pantalla. Las del router, más los flujos. */
const NOMBRE_DE_INTENCION: Readonly<Record<string, string>> = {
  retiro_no_habitual: "retiro",
  reclamo_recoleccion: "reclamo",
  programa_educa: "EDUCÁ",
  programa_transforma: "TRANSFORMÁ",
  programa_separa: "SEPARÁ",
  consulta_libre: "consulta",
  saludo: "saludo",
  despedida: "despedida",
  fuera_de_alcance: "fuera de alcance",
  no_entendido: "no entendido",
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
      origen: respuesta?.origen_respuesta ?? null,
      sinRespuesta: respuesta === null,
    });
  }

  return salidas.reverse();
}

export function Interacciones({
  mensajes,
  conversaciones,
  alcanzoElLimite,
}: {
  mensajes: MensajeDeLista[];
  conversaciones: Conversacion[];
  alcanzoElLimite: boolean;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [intencion, setIntencion] = useState<string | null>(null);
  const [origen, setOrigen] = useState<string | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [abierta, setAbierta] = useState<Conversacion | null>(null);

  const todas = useMemo(() => arma(mensajes, conversaciones), [mensajes, conversaciones]);

  const intenciones = useMemo(() => {
    const cuenta = new Map<string, number>();
    for (const i of todas) {
      if (i.intencion === null) continue;
      cuenta.set(i.intencion, (cuenta.get(i.intencion) ?? 0) + 1);
    }
    return [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
  }, [todas]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return todas.filter((i) => {
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
  }, [todas, busqueda, intencion, origen, desde, hasta]);

  const hayFiltro =
    busqueda !== "" || intencion !== null || origen !== null || desde !== "" || hasta !== "";

  function limpiar() {
    setBusqueda("");
    setIntencion(null);
    setOrigen(null);
    setDesde("");
    setHasta("");
  }

  return (
    <>
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

      {visibles.length === 0 ? (
        <div className="tarjeta vacio">
          {todas.length === 0
            ? "Todavía no hay consultas. Aparecen acá apenas alguien le escriba a Migue."
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
                const conversacion = conversaciones.find((c) => c.id === i.conversacionId) ?? null;
                return (
                  <tr key={i.id}>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{fechaCorta(i.cuando)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{i.vecino ?? "—"}</td>
                    <td style={{ maxWidth: 380 }}>
                      {conversacion === null ? (
                        <span className={i.esMedia ? "sub-fila" : undefined}>
                          {recortarTexto(i.consulta, 120)}
                        </span>
                      ) : (
                        <button
                          className="enlace-tabla"
                          onClick={() => setAbierta(conversacion)}
                          title="Ver la charla completa y qué contestó Migue"
                        >
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {abierta && <Transcripcion conversacion={abierta} alCerrar={() => setAbierta(null)} />}
    </>
  );
}
