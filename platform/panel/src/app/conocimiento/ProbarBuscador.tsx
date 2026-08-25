"use client";

import { useState } from "react";
import type { Coincidencia } from "@/lib/tipos";
import { probarBusqueda } from "./acciones";

/**
 * Probar una pregunta contra el buscador real del bot.
 *
 * Usa `probar_conocimiento`, que delega en la MISMA `buscar_conocimiento` que
 * usa Migue. No es una simulación parecida: es la misma función. Si fuera una
 * copia, el panel probaría una cosa y el vecino recibiría otra.
 *
 * Muestra el MATERIAL que Migue encontraría, no la respuesta que redactaría. Es
 * a propósito: el material es lo que se puede corregir desde este panel. Si el
 * material está bien y la respuesta sale mal, el problema es del prompt, y eso
 * es otra pantalla.
 */
export function ProbarBuscador() {
  const [abierto, setAbierto] = useState(false);
  const [consulta, setConsulta] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [resultado, setResultado] = useState<Coincidencia[] | null>(null);
  const [problema, setProblema] = useState<string | null>(null);

  async function buscar() {
    setBuscando(true);
    setProblema(null);
    const r = await probarBusqueda(consulta);
    if (r.ok) setResultado(r.coincidencias);
    else {
      setResultado(null);
      setProblema(r.mensaje);
    }
    setBuscando(false);
  }

  if (!abierto) {
    return (
      <div style={{ marginBottom: 18 }}>
        <button onClick={() => setAbierto(true)}>Probar qué encuentra Migue</button>
      </div>
    );
  }

  return (
    <div className="tarjeta" style={{ padding: 18, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h2 style={{ fontSize: "1rem" }}>Probar qué encuentra Migue</h2>
        <button className="chico" onClick={() => setAbierto(false)}>
          Cerrar
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void buscar();
        }}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input
          type="text"
          value={consulta}
          onChange={(e) => setConsulta(e.target.value)}
          placeholder="¿Cuándo pasa el camión por mi casa?"
          style={{ flex: "1 1 260px" }}
        />
        <button className="primario" type="submit" disabled={buscando || consulta.trim() === ""}>
          {buscando ? "Buscando…" : "Buscar"}
        </button>
      </form>

      <p className="ayuda">
        Es la misma búsqueda que hace el bot. Muestra el material que encontraría, no la respuesta
        que redactaría con él.
      </p>

      {problema && (
        <div className="aviso mal" style={{ marginTop: 12 }} role="alert">
          {problema}
        </div>
      )}

      {resultado !== null && (
        <div style={{ marginTop: 12 }}>
          {resultado.length === 0 ? (
            <div className="aviso atencion">
              No encontró nada. Con esta pregunta Migue le diría al vecino que no sabe, y la pregunta
              queda registrada en «No supo responder».
            </div>
          ) : (
            <>
              <div className="ayuda" style={{ marginTop: 0, marginBottom: 8 }}>
                {resultado.length} coincidencias, de mayor a menor relevancia:
              </div>
              <div className="envoltorio-tabla">
                <table>
                  <thead>
                    <tr>
                      <th className="num">Peso</th>
                      <th>Origen</th>
                      <th>Material</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.map((c) => (
                      <tr key={`${c.origen}-${c.id}`}>
                        <td className="num">{c.rank.toFixed(3)}</td>
                        <td>
                          <span className={`chip ${c.origen === "faq" ? "ok" : "pend"}`}>
                            {c.origen === "faq" ? "respuesta propia" : "documento"}
                          </span>
                          {c.difuso && (
                            <div className="sub-fila" style={{ marginTop: 3 }}>
                              por parecido
                            </div>
                          )}
                        </td>
                        <td style={{ maxWidth: 520 }}>
                          {c.titulo && <div className="titulo-fila">{c.titulo}</div>}
                          <div style={{ fontSize: "0.86rem", color: "var(--tinta-media)" }}>
                            {c.texto.replace(/\s+/g, " ").slice(0, 190)}
                            {c.texto.length > 190 ? "…" : ""}
                          </div>
                          {c.documento_titulo && (
                            <div className="sub-fila" style={{ marginTop: 3 }}>
                              {c.documento_titulo}
                              {c.pagina ? ` · p. ${c.pagina}` : ""}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
