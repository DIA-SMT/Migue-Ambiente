"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { interpolar, marcadoresDe } from "@migue/dominio/compartido";
import { fechaLegible, type TextoBot } from "@/lib/tipos";
import { guardarTexto, type Resultado } from "./acciones";

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
 *
 * Es una pestaña de Conocimiento y no una pantalla aparte porque las cuatro
 * cosas de esa pantalla son lo mismo visto de cerca: todo lo que Migue dice y el
 * área puede cambiar. Tener «Textos del bot» en el menú, al lado de
 * «Conocimiento», obligaba a saber de antemano en cuál de las dos vivía la frase
 * que se quería corregir.
 *
 * Lo que SÍ distingue a estos textos de una pregunta frecuente, y la pantalla lo
 * dice: estas 21 claves son FIJAS. El código las busca por nombre, así que se
 * edita el texto pero no se agregan ni se borran. Sin decirlo, alguien busca el
 * botón de «nuevo» y no lo encuentra.
 */
export function EditorTextos({
  grupos,
  sinAgrupar,
  ejemplos,
}: {
  grupos: Grupo[];
  sinAgrupar: TextoBot[];
  ejemplos: Record<string, string>;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState<string | null>(null);
  const [borradores, setBorradores] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<(Resultado & { clave: string }) | null>(null);

  async function guardar(clave: string) {
    setGuardando(clave);
    const r = await guardarTexto(clave, borradores[clave] ?? "");
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
    // Por CLAVE y no contra la lista global: `interpolar()` corre en dos pasos de
    // flujo y en ningún otro lado, así que un `{plazo}` bien escrito en
    // `bienvenida` le llega al vecino con las llaves. La lista global decía que
    // era válido.
    const admite = marcadoresDe(t.clave);
    const invalidos = [...new Set(usados.filter((u) => !admite.includes(u)))];

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
                {admite.length === 0 ? (
                  <>
                    Este mensaje no acepta marcadores: {invalidos.join(", ")} se{" "}
                    {invalidos.length === 1 ? "le" : "les"} enviaría al vecino con las llaves
                    puestas. Sólo los mensajes de confirmación de un trámite los resuelven.
                  </>
                ) : (
                  <>
                    {invalidos.join(", ")} no {invalidos.length === 1 ? "es" : "son"} de los que el
                    bot reemplaza acá: se {invalidos.length === 1 ? "lo" : "los"} enviaría al vecino
                    con las llaves puestas. En este mensaje valen {admite.join(", ")}.
                  </>
                )}
              </div>
            )}

            {/* Qué acepta ESTA frase. Sin decirlo hay que adivinar, y la lista
                global de arriba —que estaba antes— afirmaba que los cuatro
                servían en todas, que es justamente lo que no es cierto. */}
            <p className="ayuda">
              {admite.length === 0
                ? "Este mensaje se envía tal cual: no acepta marcadores."
                : `Acepta ${admite.join(", ")}. El bot los reemplaza al enviar.`}
            </p>

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

      {/*
        Acá había un cartel que listaba los cuatro marcadores como «disponibles»,
        sin más. Era falso y de la forma más costosa: afirmaba que servían en
        cualquier mensaje, cuando `interpolar()` se llama en DOS pasos de flujo y
        en ningún otro lado. Alguien podía escribir «te contesto en {plazo}» en la
        bienvenida, guardarlo sin protesta, y el vecino recibía las llaves.

        Ahora cada frase dice qué acepta, mientras se la edita, y las dos que
        aceptan algo lo dicen en su grupo. Un dato correcto en el lugar donde se
        usa vale más que una lista completa arriba.
      */}
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
