"use client";

import { useState } from "react";
import {
  aTexto,
  GRUPOS_DE_REGLAS,
  SEGUNDOS_DE_CACHE,
  validarValor,
  type DefinicionClave,
} from "@/lib/reglas";
import { fechaLegible, type FilaConfiguracion } from "@/lib/tipos";
import { guardarConfig, type Resultado } from "./acciones";

/**
 * Las claves de `configuracion`, agrupadas por lo que hacen.
 *
 * Cada una se edita en su lugar y se guarda sola. No hay un botón «guardar todo»
 * a propósito: son diecinueve valores de consecuencias muy distintas —uno cambia
 * el modelo de lenguaje, otro cuántas horas dura una conversación— y un guardado
 * masivo invita a tocar cinco y no saber cuál rompió algo.
 *
 * La validación corre MIENTRAS se escribe, con la misma función que valida al
 * guardar. Y lo que se muestra no es «valor inválido» sino la consecuencia: para
 * `sla_modo` el aviso dice que el bot se cae en el último paso del pedido,
 * después de que el vecino ya mandó la foto.
 */
export function Configuracion({
  filas,
  alGuardar,
}: {
  filas: FilaConfiguracion[];
  alGuardar: (r: Resultado) => void;
}) {
  const porClave = new Map(filas.map((f) => [f.clave, f]));
  const [borradores, setBorradores] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState<string | null>(null);

  // Claves que la base tiene y esta pantalla no describe. Se muestran igual: una
  // regla invisible es una que nadie puede corregir cuando esté mal.
  const conocidas = new Set(GRUPOS_DE_REGLAS.flatMap((g) => g.claves).map((d) => d.clave));
  const desconocidas = filas.filter((f) => !conocidas.has(f.clave));

  async function guardar(def: DefinicionClave, texto: string) {
    setGuardando(def.clave);
    const r = await guardarConfig(def.clave, texto);
    alGuardar(r);
    setGuardando(null);
    if (r.ok) {
      setBorradores((b) => {
        const { [def.clave]: _, ...resto } = b;
        return resto;
      });
    }
  }

  function campo(def: DefinicionClave) {
    const fila = porClave.get(def.clave);
    if (!fila) {
      // El código la lee y la fila no existe: el bot cae a un valor por defecto
      // silencioso. Ya pasó en este proyecto con la migración 015, que nunca se
      // había aplicado y dejó dos claves faltantes.
      return (
        <div key={def.clave} className="tarjeta" style={{ padding: 14, marginBottom: 10 }}>
          <div className="titulo-fila">{def.rotulo}</div>
          <div className="aviso mal" style={{ marginTop: 8 }}>
            Esta regla no está en la base. El bot va a usar un valor por defecto que no se ve desde
            acá. Hace falta cargarla por SQL.
          </div>
        </div>
      );
    }

    const original = aTexto(def, fila.valor);
    const valor = borradores[def.clave] ?? original;
    const cambiado = valor !== original;
    const v = validarValor(def, valor);

    return (
      <div
        key={def.clave}
        className={`tarjeta regla ${def.huerfana ? "de-baja" : ""}`}
        style={{ padding: 14, marginBottom: 10 }}
      >
        <div className="regla-cabecera">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="titulo-fila">
              {def.rotulo}
              {def.consecuencia === "alta" && !def.huerfana && (
                <span className="chip alerta" style={{ marginLeft: 8 }}>
                  cambia lo que recibe el vecino
                </span>
              )}
              {def.huerfana && (
                <span className="chip pend" style={{ marginLeft: 8 }}>
                  no conectada
                </span>
              )}
            </div>
            <div className="sub-fila">{def.clave}</div>
            <p className="ayuda" style={{ maxWidth: "72ch" }}>
              {def.queHace}
            </p>
          </div>
          <span className="sub-fila" style={{ whiteSpace: "nowrap" }}>
            {fila.actualizado_por === null ? "nunca editada" : fechaLegible(fila.actualizado_en)}
          </span>
        </div>

        {def.huerfana && (
          <div className="aviso info" style={{ marginTop: 4 }}>
            {def.huerfana}
          </div>
        )}

        <div className="regla-control">
          {def.tipo === "booleano" ? (
            <select
              value={valor}
              onChange={(e) => setBorradores((b) => ({ ...b, [def.clave]: e.target.value }))}
            >
              <option value="true">Sí</option>
              <option value="false">No</option>
            </select>
          ) : def.tipo === "opcion" ? (
            <select
              value={valor}
              onChange={(e) => setBorradores((b) => ({ ...b, [def.clave]: e.target.value }))}
            >
              {(def.opciones ?? []).map((o) => (
                <option key={o.valor} value={o.valor}>
                  {o.rotulo}
                </option>
              ))}
            </select>
          ) : def.tipo === "lista" ? (
            <textarea
              value={valor}
              onChange={(e) => setBorradores((b) => ({ ...b, [def.clave]: e.target.value }))}
              placeholder="Uno por línea"
              style={{ minHeight: 80, fontFamily: "var(--mono)", fontSize: "0.88rem" }}
            />
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="text"
                value={valor}
                onChange={(e) => setBorradores((b) => ({ ...b, [def.clave]: e.target.value }))}
                style={{ maxWidth: def.tipo === "texto" ? 380 : 130 }}
              />
              {def.unidad && <span className="sub-fila">{def.unidad}</span>}
            </div>
          )}

          {cambiado && (
            <button
              className="primario chico"
              disabled={guardando === def.clave || !v.ok}
              onClick={() => void guardar(def, valor)}
            >
              {guardando === def.clave ? "Guardando…" : "Guardar"}
            </button>
          )}
          {cambiado && (
            <button
              className="chico"
              onClick={() =>
                setBorradores((b) => {
                  const { [def.clave]: _, ...resto } = b;
                  return resto;
                })
              }
            >
              Deshacer
            </button>
          )}
        </div>

        {/* Primero el error de validación; sólo si el valor es válido se muestra
            la consecuencia. Los dos juntos sería ruido. */}
        {!v.ok ? (
          <div className="aviso mal" style={{ marginTop: 10 }}>
            {v.mensaje}
            {def.siSeRompe && <div style={{ marginTop: 5 }}>{def.siSeRompe}</div>}
          </div>
        ) : (
          cambiado &&
          def.siSeRompe && (
            <div className="detalle-problema" style={{ marginTop: 8 }}>
              {def.siSeRompe}
            </div>
          )
        )}
      </div>
    );
  }

  return (
    <>
      <div className="aviso info" style={{ marginTop: 16 }}>
        El bot tiene estas reglas en memoria y las relee cada {SEGUNDOS_DE_CACHE} segundos. Si
        guardás y probás en Telegram enseguida, vas a ver el valor viejo: esperá un minuto.
      </div>

      {GRUPOS_DE_REGLAS.map((g) => (
        <section key={g.rotulo} style={{ marginTop: 26 }}>
          <h2>{g.rotulo}</h2>
          {g.explicacion && (
            <p className="bajada" style={{ marginTop: 4, marginBottom: 14 }}>
              {g.explicacion}
            </p>
          )}
          {g.claves.map(campo)}
        </section>
      ))}

      {desconocidas.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <h2>Sin describir</h2>
          <p className="bajada" style={{ marginTop: 4, marginBottom: 14 }}>
            Están en la base y esta pantalla no sabe qué son, así que no puede validar lo que se
            escriba. Se muestran de sólo lectura: editarlas a ciegas es el caso donde un valor mal
            puesto pasa sin que nada lo note.
          </p>
          {desconocidas.map((f) => (
            <div key={f.clave} className="tarjeta" style={{ padding: 14, marginBottom: 10 }}>
              <div className="titulo-fila">{f.clave}</div>
              {f.descripcion && <p className="ayuda">{f.descripcion}</p>}
              <code>{JSON.stringify(f.valor)}</code>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
