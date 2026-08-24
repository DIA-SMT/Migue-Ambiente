"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { interpolar } from "@migue/dominio/compartido";
import { fechaLegible } from "@/lib/tipos";
import { guardarTexto, type Resultado } from "./acciones";
import type { TextoBot } from "./page";

interface Grupo {
  rotulo: string;
  explicacion: string;
  textos: TextoBot[];
  faltantes: string[];
}

/**
 * Editor de los mensajes del bot, con vista previa.
 *
 * La vista previa usa `interpolar()` del dominio: la MISMA función que resuelve
 * los marcadores cuando el bot envía el mensaje. Si acá se usara una versión
 * propia, la vista previa mentiría — y una vista previa que miente es peor que
 * no tenerla, porque da confianza para publicar.
 */
export function EditorTextos({
  grupos,
  sinAgrupar,
  marcadores,
  ejemplos,
}: {
  grupos: Grupo[];
  sinAgrupar: TextoBot[];
  marcadores: string[];
  ejemplos: Record<string, string>;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState<string | null>(null);
  const [borradores, setBorradores] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<(Resultado & { clave: string }) | null>(null);

  async function guardar(clave: string) {
    setGuardando(clave);
    const r = await guardarTexto(clave, borradores[clave] ?? "", marcadores);
    setAviso({ ...r, clave });
    setGuardando(null);
    if (r.ok) {
      setBorradores((b) => {
        const { [clave]: _, ...resto } = b;
        return resto;
      });
      setAbierto(null);
      router.refresh();
    }
  }

  function fila(t: TextoBot) {
    const editando = abierto === t.clave;
    const valor = borradores[t.clave] ?? t.texto;
    const cambiado = valor.trim() !== t.texto.trim();
    const usados = [...valor.matchAll(/\{[a-zA-Z_]+\}/g)].map((m) => m[0]);
    const invalidos = [...new Set(usados.filter((u) => !marcadores.includes(u)))];

    return (
      <div key={t.clave} className="tarjeta" style={{ padding: 16, marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="sub-fila" style={{ marginBottom: 4 }}>
              {t.clave}
            </div>
            {t.descripcion && (
              <p className="ayuda" style={{ marginTop: 0, marginBottom: 8, maxWidth: "70ch" }}>
                {t.descripcion}
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <span className="sub-fila">{fechaLegible(t.actualizado_en)}</span>
            {!editando && (
              <button className="chico" onClick={() => setAbierto(t.clave)}>
                Editar
              </button>
            )}
          </div>
        </div>

        {editando ? (
          <>
            <textarea
              value={valor}
              onChange={(e) => setBorradores((b) => ({ ...b, [t.clave]: e.target.value }))}
              style={{ minHeight: 120, fontSize: "0.93rem" }}
              autoFocus
            />

            {invalidos.length > 0 && (
              <div className="aviso mal" style={{ marginTop: 10 }}>
                {invalidos.join(", ")} no {invalidos.length === 1 ? "es un marcador" : "son marcadores"} válido
                {invalidos.length === 1 ? "" : "s"}: el bot se {invalidos.length === 1 ? "lo" : "los"} enviaría
                al vecino con las llaves puestas.
              </div>
            )}

            {/* La vista previa sólo aparece si hay marcadores: sin ellos el texto
                de arriba ya ES lo que ve el vecino, y repetirlo sería ruido. */}
            {usados.length > 0 && invalidos.length === 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="ayuda" style={{ marginTop: 0, marginBottom: 5 }}>
                  Así lo va a leer el vecino:
                </div>
                <div className="vista-previa">{interpolar(valor, ejemplos)}</div>
              </div>
            )}

            <div className="acciones" style={{ marginTop: 14 }}>
              <button
                className="primario"
                disabled={guardando === t.clave || !cambiado || invalidos.length > 0}
                onClick={() => void guardar(t.clave)}
              >
                {guardando === t.clave ? "Guardando…" : "Guardar"}
              </button>
              <button
                onClick={() => {
                  setBorradores((b) => {
                    const { [t.clave]: _, ...resto } = b;
                    return resto;
                  });
                  setAbierto(null);
                }}
              >
                Cancelar
              </button>
            </div>
          </>
        ) : (
          <div className="texto-actual">{t.texto}</div>
        )}

        {aviso?.clave === t.clave && !aviso.ok && (
          <div className="aviso mal" style={{ marginTop: 10, marginBottom: 0 }} role="alert">
            {aviso.mensaje}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {aviso?.ok && (
        <div className="aviso ok" role="status">
          {aviso.mensaje}
        </div>
      )}

      <div className="aviso info">
        <strong>Marcadores disponibles:</strong>{" "}
        {marcadores.map((m) => (
          <code key={m} style={{ marginRight: 6 }}>
            {m}
          </code>
        ))}
        <div style={{ marginTop: 5, fontSize: "0.85rem" }}>
          El bot los reemplaza al enviar. Cualquier otra cosa entre llaves se envía con las llaves
          puestas.
        </div>
      </div>

      {grupos.map((g) => (
        <section key={g.rotulo} style={{ marginTop: 26 }}>
          <h2>{g.rotulo}</h2>
          <p className="bajada" style={{ marginBottom: 14 }}>
            {g.explicacion}
          </p>

          {g.faltantes.length > 0 && (
            <div className="aviso atencion">
              {g.faltantes.length === 1 ? "Falta el texto" : "Faltan los textos"}{" "}
              <code>{g.faltantes.join("</code>, <code>")}</code> en la base. El bot
              {g.faltantes.length === 1 ? " lo busca" : " los busca"} y no{" "}
              {g.faltantes.length === 1 ? "lo encuentra" : "los encuentra"}.
            </div>
          )}

          {g.textos.map(fila)}
        </section>
      ))}

      {sinAgrupar.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <h2>Otros</h2>
          <p className="bajada" style={{ marginBottom: 14 }}>
            Textos que existen en la base y todavía no están asignados a un flujo en esta pantalla.
          </p>
          {sinAgrupar.map(fila)}
        </section>
      )}
    </>
  );
}
