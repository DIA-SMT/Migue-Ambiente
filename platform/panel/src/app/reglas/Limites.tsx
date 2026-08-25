"use client";

import { useState } from "react";
import type { FilaLimite } from "@/lib/tipos";
import { guardarLimite, simularVolumen, type Resultado } from "./acciones";

/**
 * Los límites del servicio gratuito, con un simulador.
 *
 * El simulador no es un adorno: `limites_volumen` NO decide sola. Dos constantes
 * del código intervienen y no se ven desde ninguna parte —la equivalencia de una
 * bolsa en metros cúbicos, y un margen de duda alrededor del límite— así que un
 * operador que baje el límite de voluminosos y vea que el bot pregunta de más no
 * tendría forma de entender por qué.
 *
 * Se muestra el EFECTO en vez de exponer las constantes: lo que hace falta saber
 * es qué va a pasar con «3 bolsas», no que el factor de conversión sea 0,04.
 *
 * Y las tres categorías son FIJAS: un CHECK de la base las limita, y agregar una
 * cuarta necesita una migración más un cambio en el tipo del dominio y en las
 * opciones del flujo. Por eso no hay botón de «agregar»: fallaría con un 23514.
 */
export function Limites({
  filas,
  alGuardar,
}: {
  filas: FilaLimite[];
  alGuardar: (r: Resultado) => void;
}) {
  const [borradores, setBorradores] = useState<Record<string, Partial<FilaLimite>>>({});
  const [guardando, setGuardando] = useState<string | null>(null);

  const [categoriaPrueba, setCategoriaPrueba] = useState<FilaLimite["categoria"]>("escombros");
  const [frase, setFrase] = useState("3 bolsas");
  const [simulando, setSimulando] = useState(false);
  const [simulacion, setSimulacion] = useState<
    { resumen: string; detalle: string; tono: string } | { error: string } | null
  >(null);

  function valorDe<K extends keyof FilaLimite>(f: FilaLimite, campo: K): FilaLimite[K] {
    const b = borradores[f.categoria];
    return (b && campo in b ? (b[campo] as FilaLimite[K]) : f[campo])!;
  }

  function editar(cat: string, cambio: Partial<FilaLimite>) {
    setBorradores((b) => ({ ...b, [cat]: { ...b[cat], ...cambio } }));
  }

  async function guardar(f: FilaLimite) {
    setGuardando(f.categoria);
    const r = await guardarLimite({
      categoria: f.categoria,
      limiteValor: String(valorDe(f, "limite_valor")),
      accionAlExceder: String(valorDe(f, "accion_al_exceder")),
      textoExceso: String(valorDe(f, "texto_exceso") ?? ""),
      activo: Boolean(valorDe(f, "activo")),
    });
    alGuardar(r);
    setGuardando(null);
    if (r.ok) {
      setBorradores((b) => {
        const { [f.categoria]: _, ...resto } = b;
        return resto;
      });
    }
  }

  async function simular() {
    setSimulando(true);
    // Se le pasan los límites tal como están GUARDADOS, no los borradores: el
    // simulador tiene que decir qué hace el bot hoy, y el bot lee la base.
    const r = await simularVolumen(
      categoriaPrueba,
      frase,
      filas.map((f) => ({
        categoria: f.categoria,
        etiqueta: f.etiqueta,
        limiteValor: Number(f.limite_valor),
        limiteUnidad: f.limite_unidad as "bolsas" | "m3",
        pesoMaxBolsaKg: f.peso_max_bolsa_kg,
        accionAlExceder: f.accion_al_exceder,
        textoExceso: f.texto_exceso,
        palabras: f.palabras,
        activo: f.activo,
      })),
    );
    setSimulacion(r.ok ? { resumen: r.resumen, detalle: r.detalle, tono: r.tono } : { error: r.mensaje });
    setSimulando(false);
  }

  return (
    <>
      <p className="bajada" style={{ marginTop: 16 }}>
        Hasta cuánto retira el municipio sin cargo, por categoría. Pasado el límite, Migue puede
        tomar el pedido avisando que el retiro es parcial, o no tomarlo y derivar.
      </p>

      <div className="aviso info">
        Las tres categorías son fijas: agregar una cuarta necesita un cambio en la base y en el
        código del bot, no se puede desde acá.
      </div>

      {filas.map((f) => {
        const b = borradores[f.categoria];
        const cambiado = b !== undefined && Object.keys(b).length > 0;
        const activo = Boolean(valorDe(f, "activo"));

        return (
          <div
            key={f.categoria}
            className={`tarjeta regla ${activo ? "" : "de-baja"}`}
            style={{ padding: 16, marginBottom: 12 }}
          >
            <div className="regla-cabecera">
              <div>
                <div className="titulo-fila">{f.etiqueta}</div>
                <div className="sub-fila">{f.categoria}</div>
              </div>
              <label style={{ display: "flex", gap: 7, alignItems: "center", fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={activo}
                  onChange={(e) => editar(f.categoria, { activo: e.target.checked })}
                  style={{ width: "auto" }}
                />
                <span>Activo</span>
              </label>
            </div>

            {!activo && (
              // El switch parece inocuo y no lo es: desactivar un límite no
              // relaja el flujo, lo ROMPE. `limiteDe()` devuelve null y el paso
              // aborta con «sin_limite_configurado», después de que el vecino ya
              // mandó la foto y la dirección.
              <div className="aviso mal" style={{ marginTop: 4 }}>
                Desactivar un límite no lo relaja: lo rompe. Un pedido de esta categoría se cae en
                el último paso, después de que el vecino mandó la foto y la dirección, y queda sin
                ticket. Para permitir más cantidad, subí el límite en lugar de desactivarlo.
              </div>
            )}

            <div className="regla-control">
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="sub-fila">Hasta</span>
                <input
                  type="text"
                  value={String(valorDe(f, "limite_valor"))}
                  onChange={(e) => editar(f.categoria, { limite_valor: e.target.value as never })}
                  style={{ maxWidth: 90 }}
                />
                <span className="sub-fila">{f.limite_unidad}</span>
              </div>

              <select
                value={String(valorDe(f, "accion_al_exceder"))}
                onChange={(e) =>
                  editar(f.categoria, { accion_al_exceder: e.target.value as never })
                }
                style={{ width: "auto" }}
              >
                <option value="parcial_con_ticket">Si se pasa: retiro parcial, con ticket</option>
                <option value="derivar_sin_ticket">Si se pasa: derivar sin tomar el pedido</option>
              </select>
            </div>

            {String(valorDe(f, "accion_al_exceder")) === "derivar_sin_ticket" && (
              <p className="ayuda">
                Con esta opción, y sólo con esta, Migue le muestra al vecino la lista de Puntos
                Verdes.
              </p>
            )}

            <div className="campo" style={{ marginTop: 12 }}>
              <label>Lo que Migue le dice al vecino cuando se pasa</label>
              <textarea
                value={String(valorDe(f, "texto_exceso") ?? "")}
                onChange={(e) => editar(f.categoria, { texto_exceso: e.target.value })}
                style={{ minHeight: 74 }}
              />
              <p className="ayuda">
                Se envía tal cual. Si queda vacío, Migue usa un texto genérico armado con el nombre
                de la categoría.
              </p>
            </div>

            {cambiado && (
              <div className="acciones">
                <button
                  className="primario chico"
                  disabled={guardando === f.categoria}
                  onClick={() => void guardar(f)}
                >
                  {guardando === f.categoria ? "Guardando…" : "Guardar"}
                </button>
                <button
                  className="chico"
                  onClick={() =>
                    setBorradores((prev) => {
                      const { [f.categoria]: _, ...resto } = prev;
                      return resto;
                    })
                  }
                >
                  Deshacer
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* ---------------------------------------------------------------- */}

      <section style={{ marginTop: 28 }}>
        <h2>Probar qué haría Migue</h2>
        <p className="bajada" style={{ marginTop: 4 }}>
          Estos límites no deciden solos. Cuando el vecino habla en bolsas y el límite está en
          metros cúbicos hay que convertir, y alrededor del límite el bot prefiere repreguntar
          antes que equivocarse. Eso explica por qué a veces pregunta de más, y no se ve en los
          números de arriba.
        </p>

        <div className="tarjeta" style={{ padding: 16 }}>
          <div className="regla-control">
            <select
              value={categoriaPrueba}
              onChange={(e) => setCategoriaPrueba(e.target.value as FilaLimite["categoria"])}
              style={{ width: "auto" }}
            >
              {filas.map((f) => (
                <option key={f.categoria} value={f.categoria}>
                  {f.etiqueta}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={frase}
              onChange={(e) => setFrase(e.target.value)}
              placeholder="3 bolsas, media camionada, 2 m3…"
              style={{ maxWidth: 280 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void simular();
              }}
            />
            <button className="primario chico" disabled={simulando} onClick={() => void simular()}>
              {simulando ? "Probando…" : "Probar"}
            </button>
          </div>

          <p className="ayuda">
            Se prueba contra los límites <strong>guardados</strong>, no contra lo que estés
            editando arriba: el bot lee la base.
          </p>

          {simulacion !== null &&
            ("error" in simulacion ? (
              <div className="aviso mal" style={{ marginTop: 12 }}>
                {simulacion.error}
              </div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <span className={`chip ${simulacion.tono}`}>{simulacion.resumen}</span>
                <p style={{ marginTop: 8, maxWidth: "72ch", color: "var(--tinta-media)" }}>
                  {simulacion.detalle}
                </p>
              </div>
            ))}
        </div>
      </section>
    </>
  );
}
