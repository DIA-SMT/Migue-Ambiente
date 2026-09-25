"use client";

import { useMemo, useState } from "react";
import type { Faq } from "@/lib/tipos";

/**
 * Las preguntas frecuentes, en tarjetas agrupadas por tema.
 *
 * POR QUÉ NO UNA TABLA. Era una fila por FAQ, con la respuesta recortada a 200
 * caracteres en una celda. Funciona para mirar una lista de siete; deja de
 * funcionar cuando hay cuarenta, que es a donde va esto. Una FAQ se juzga
 * leyéndola entera —¿contesta de verdad lo que pregunta el vecino?— y en una
 * celda de tabla no se lee.
 *
 * La referencia es el panel del bot de Turismo, que tiene 101 cargadas y las
 * muestra así. Con siete se va a ver espaciado; es el precio de que la pantalla
 * siga sirviendo cuando haya cuarenta.
 *
 * TRES DECISIONES QUE NO SON OBVIAS.
 *
 * Se agrupa por la PRIMERA etiqueta. Nuestras FAQs tienen varias —«limites,
 * retiro»— mientras que en el panel de referencia cada una pertenece a una sola
 * categoría. Repetir la misma FAQ en todos sus grupos haría que el conteo de las
 * píldoras sume más que el total, y eso confunde más de lo que ayuda. La primera
 * etiqueta manda y el resto se ven como chips en la tarjeta.
 *
 * Los marcadores se muestran como CHIP, no resueltos. Una FAQ dice «{limites}» y
 * no «hasta 5 bolsas» a propósito: el valor vive en la tabla de Reglas y se
 * resuelve al enviar. Mostrarlo resuelto acá tentaría a editarlo acá, que es
 * exactamente la segunda fuente de verdad que el proyecto viene evitando. El
 * chip dice que ahí va un valor vivo; para ver la respuesta final está «Probar
 * el buscador», arriba en esta misma pantalla.
 *
 * Los USOS se ven en la tarjeta. Es el dato que dice cuáles se ganan el lugar y
 * cuáles no las encuentra nadie, y en la tabla vivía en una columna estrecha al
 * final. Una FAQ con cero usos después de un mes es una pregunta que ningún
 * vecino hace, o una que está escrita con palabras que nadie usa.
 */

/** Cómo se lee un marcador cuando se lo muestra como chip. */
const NOMBRE_DEL_MARCADOR: Readonly<Record<string, string>> = {
  "{limites}": "los límites de volumen",
  "{zonas}": "los días por zona",
  "{puntos_verdes}": "los Puntos Verdes",
  "{plazo_habitual}": "el plazo",
  "{empresa}": "la empresa",
};

/** Parte una respuesta en texto y marcadores, para pintarlos distinto. */
function partirPorMarcadores(texto: string): { texto: string; marcador: boolean }[] {
  return texto
    .split(/(\{\w+\})/g)
    .filter((p) => p !== "")
    .map((p) => ({ texto: p, marcador: /^\{\w+\}$/.test(p) }));
}

const SIN_TEMA = "sin tema";

export function ListaFaqs({
  faqs,
  pendiente,
  confirmando,
  alEditar,
  alPublicar,
  alPedirBorrar,
  alBorrar,
  alCancelarBorrado,
}: {
  faqs: Faq[];
  pendiente: boolean;
  confirmando: string | null;
  alEditar: (f: Faq) => void;
  alPublicar: (f: Faq) => void;
  alPedirBorrar: (id: string) => void;
  alBorrar: (id: string) => void;
  alCancelarBorrado: () => void;
}) {
  const [tema, setTema] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [verBorradores, setVerBorradores] = useState(true);

  const temaDe = (f: Faq) => f.etiquetas[0] ?? SIN_TEMA;

  /** Los temas con su cuenta, ordenados por cuántas FAQs tienen. */
  const temas = useMemo(() => {
    const cuenta = new Map<string, number>();
    for (const f of faqs) cuenta.set(temaDe(f), (cuenta.get(temaDe(f)) ?? 0) + 1);
    return [...cuenta.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"));
  }, [faqs]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return faqs.filter((f) => {
      if (!verBorradores && !f.activa) return false;
      if (tema !== null && temaDe(f) !== tema) return false;
      if (q === "") return true;
      return (
        f.pregunta.toLowerCase().includes(q) ||
        f.respuesta.toLowerCase().includes(q) ||
        f.etiquetas.some((e) => e.toLowerCase().includes(q))
      );
    });
  }, [faqs, tema, busqueda, verBorradores]);

  /** Las visibles, agrupadas por tema y en el mismo orden que las píldoras. */
  const grupos = useMemo(() => {
    const porTema = new Map<string, Faq[]>();
    for (const f of visibles) {
      const t = temaDe(f);
      porTema.set(t, [...(porTema.get(t) ?? []), f]);
    }
    return temas
      .map(([t]) => [t, porTema.get(t) ?? []] as const)
      .filter(([, lista]) => lista.length > 0);
  }, [visibles, temas]);

  const borradores = faqs.filter((f) => !f.activa).length;

  return (
    <div className="faqs">
      <div className="faqs-filtros">
        <input
          type="search"
          className="buscador"
          placeholder="Buscar en las preguntas frecuentes…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          aria-label="Buscar en las preguntas frecuentes"
        />
        {borradores > 0 && (
          <label className="faqs-borradores">
            <input
              type="checkbox"
              checked={verBorradores}
              onChange={(e) => setVerBorradores(e.target.checked)}
            />
            Mostrar borradores ({borradores})
          </label>
        )}
        <span className="faqs-cuenta">
          {visibles.length} de {faqs.length}
        </span>
      </div>

      <div className="faqs-temas" role="tablist" aria-label="Filtrar por tema">
        <button
          type="button"
          role="tab"
          aria-selected={tema === null}
          className={`pildora${tema === null ? " activa" : ""}`}
          onClick={() => setTema(null)}
        >
          Todas <span className="pildora-cuenta">{faqs.length}</span>
        </button>
        {temas.map(([t, n]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tema === t}
            className={`pildora${tema === t ? " activa" : ""}`}
            onClick={() => setTema(tema === t ? null : t)}
          >
            {t} <span className="pildora-cuenta">{n}</span>
          </button>
        ))}
      </div>

      {visibles.length === 0 ? (
        <div className="tarjeta vacio">
          Ninguna coincide con lo que buscaste.{" "}
          <button
            className="enlace-tabla"
            onClick={() => {
              setBusqueda("");
              setTema(null);
              setVerBorradores(true);
            }}
          >
            Ver todas
          </button>
        </div>
      ) : (
        grupos.map(([t, lista]) => (
          <section key={t} className="faqs-grupo">
            <h3 className="faqs-grupo-titulo">
              <span className="faqs-grupo-nombre">{t}</span>
              <span className="faqs-grupo-cuenta">
                {lista.length} {lista.length === 1 ? "pregunta" : "preguntas"}
              </span>
            </h3>

            <div className="faqs-grilla">
              {lista.map((f) => (
                <article key={f.id} className={`faq-tarjeta${f.activa ? "" : " de-baja"}`}>
                  <div className="faq-cabecera">
                    <span className={`chip ${f.activa ? "ok" : "curso"}`}>
                      {f.activa ? "en uso" : "borrador"}
                    </span>
                    <span className="faq-usos" title="Cuántas veces Migue la usó para responder">
                      {f.veces_usada === 0 ? "sin usos todavía" : `${f.veces_usada} usos`}
                    </span>
                  </div>

                  <h4 className="faq-pregunta">{f.pregunta}</h4>

                  <p className="faq-respuesta">
                    {partirPorMarcadores(f.respuesta).map((parte, i) =>
                      parte.marcador ? (
                        <span
                          key={i}
                          className="marcador"
                          title={`Se reemplaza al enviar por ${NOMBRE_DEL_MARCADOR[parte.texto] ?? "un valor de las tablas"}`}
                        >
                          {NOMBRE_DEL_MARCADOR[parte.texto] ?? parte.texto}
                        </span>
                      ) : (
                        <span key={i}>{parte.texto}</span>
                      ),
                    )}
                  </p>

                  {f.etiquetas.length > 1 && (
                    <div className="faq-etiquetas">
                      {f.etiquetas.slice(1).map((e) => (
                        <span key={e} className="etiqueta">
                          {e}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="faq-acciones">
                    <button className="chico" onClick={() => alEditar(f)}>
                      Editar
                    </button>
                    <button className="chico" disabled={pendiente} onClick={() => alPublicar(f)}>
                      {f.activa ? "Despublicar" : "Publicar"}
                    </button>
                    {confirmando === f.id ? (
                      <>
                        <button
                          className="chico peligro"
                          disabled={pendiente}
                          onClick={() => alBorrar(f.id)}
                        >
                          Confirmar
                        </button>
                        <button className="chico" onClick={alCancelarBorrado}>
                          No
                        </button>
                      </>
                    ) : (
                      <button className="chico peligro" onClick={() => alPedirBorrar(f.id)}>
                        Borrar
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
