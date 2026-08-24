import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import {
  estadoVisible,
  fechaLegible,
  tamanoLegible,
  type Documento,
  type Fragmento,
  type Trabajo,
} from "@/lib/tipos";
import { Metadatos } from "./Metadatos";

export const dynamic = "force-dynamic";

/**
 * Detalle de un documento.
 *
 * Se gana el lugar porque es la única forma de contestar «¿por qué Migue no
 * encuentra tal cosa en este documento?». Ver que un PDF de 43 páginas produjo
 * 4 fragmentos, o que todos tienen `titulo_seccion` en null, ES el diagnóstico.
 *
 * Sobre fragmentos es de sólo lectura, y a propósito: no hay política de update
 * para el panel y no hace falta ninguna. Si el material está mal, se arregla el
 * documento o se escribe una FAQ, que es la herramienta que existe para eso.
 */
export default async function DetalleDocumento({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const { id } = await params;
  const supabase = await clienteServidor();

  const { data: doc } = await supabase
    .from("documentos")
    .select("*")
    .eq("id", id)
    .maybeSingle<Documento>();

  if (!doc) notFound();

  const { data: fragmentos } = await supabase
    .from("fragmentos")
    .select("id, orden, texto, pagina, titulo_seccion, tokens_aprox")
    .eq("documento_id", id)
    .order("orden")
    .returns<Fragmento[]>();

  // El historial responde «el worker lo intentó 3 veces y se rindió», que es la
  // única explicación posible cuando se agotó `max_intentos`. No hay índice
  // sobre `payload`; con decenas de filas da igual.
  const { data: trabajos } = await supabase
    .from("trabajos")
    .select("id, tipo, estado, intentos, max_intentos, error_detalle, creado_en, finalizado_en, tomado_por")
    .eq("payload->>documento_id", id)
    .order("creado_en", { ascending: false })
    .limit(10)
    .returns<Trabajo[]>();

  const e = estadoVisible(doc);
  const frags = fragmentos ?? [];
  const sinSeccion = frags.filter((f) => !f.titulo_seccion).length;

  return (
    <Armazon persona={persona} actual="/documentos">
      <main>
        <p className="migaja">
          <Link href="/documentos">← Volver a documentos</Link>
        </p>

        <div className="titulo-pagina">
          <h1>{doc.titulo}</h1>
          <span className={`chip ${e.tono}`} style={{ marginTop: 8 }}>
            {e.etiqueta}
          </span>
        </div>

        {e.detalle && <div className="detalle-problema" style={{ marginBottom: 20 }}>{e.detalle}</div>}
        {!doc.activo && (
          <div className="aviso atencion">
            Está dado de baja: Migue no lo cita. Los fragmentos siguen guardados y sólo los ve el
            personal del panel.
          </div>
        )}

        <Metadatos documento={doc} />

        <section style={{ marginTop: 28 }}>
          <h2>Qué quedó indexado</h2>
          <p className="bajada">
            Estos son los pedazos que Migue puede citar. {frags.length} fragmentos
            {doc.paginas ? ` de ${doc.paginas} páginas` : ""}
            {sinSeccion > 0 && frags.length > 0
              ? ` · ${sinSeccion} sin título de sección`
              : ""}
            .
          </p>

          {frags.length === 0 ? (
            <div className="tarjeta vacio">
              No hay fragmentos. Si el documento figura como leído, es probable que sea un PDF
              escaneado: son imágenes de páginas, sin texto que extraer.
            </div>
          ) : (
            <div className="envoltorio-tabla tarjeta">
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th className="num">Pág.</th>
                    <th>Sección</th>
                    <th>Texto</th>
                    <th className="num">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {frags.map((f) => (
                    <tr key={f.id}>
                      <td className="num">{f.orden}</td>
                      <td className="num">{f.pagina ?? "—"}</td>
                      <td style={{ maxWidth: 200 }}>
                        {f.titulo_seccion ?? (
                          <span style={{ color: "var(--tinta-suave)" }}>sin sección</span>
                        )}
                      </td>
                      <td style={{ maxWidth: 520, fontSize: "0.87rem", color: "var(--tinta-media)" }}>
                        {f.texto.replace(/\s+/g, " ").slice(0, 220)}
                        {f.texto.length > 220 ? "…" : ""}
                      </td>
                      <td className="num">{f.tokens_aprox ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section style={{ marginTop: 28 }}>
          <h2>Historial de lectura</h2>
          <p className="bajada">Qué hizo el worker con este documento.</p>

          {(trabajos ?? []).length === 0 ? (
            <div className="tarjeta vacio">Sin registros.</div>
          ) : (
            <div className="envoltorio-tabla tarjeta">
              <table>
                <thead>
                  <tr>
                    <th>Trabajo</th>
                    <th>Estado</th>
                    <th className="num">Intentos</th>
                    <th>Cuándo</th>
                  </tr>
                </thead>
                <tbody>
                  {(trabajos ?? []).map((t) => (
                    <tr key={t.id}>
                      <td>
                        {t.tipo.replace(/_/g, " ")}
                        {t.error_detalle && (
                          <div className="detalle-problema">{t.error_detalle}</div>
                        )}
                      </td>
                      <td>
                        <span
                          className={`chip ${
                            t.estado === "listo"
                              ? "ok"
                              : t.estado === "error"
                                ? "alerta"
                                : t.estado === "tomado"
                                  ? "curso"
                                  : "pend"
                          }`}
                        >
                          {t.estado}
                        </span>
                      </td>
                      <td className="num">
                        {t.intentos} / {t.max_intentos}
                      </td>
                      <td>
                        {fechaLegible(t.creado_en, true)}
                        {t.tomado_por && <div className="sub-fila">{t.tomado_por}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section style={{ marginTop: 28 }}>
          <h2>Ficha técnica</h2>
          <div className="tarjeta" style={{ padding: "16px 18px", fontSize: "0.9rem" }}>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 20px" }}>
              <dt style={{ color: "var(--tinta-suave)" }}>Archivo original</dt>
              <dd style={{ margin: 0, fontFamily: "var(--mono)", fontSize: "0.85rem" }}>
                {doc.nombre_archivo}
              </dd>
              <dt style={{ color: "var(--tinta-suave)" }}>Formato y tamaño</dt>
              <dd style={{ margin: 0 }}>
                {doc.formato.toUpperCase()} · {tamanoLegible(doc.bytes)}
              </dd>
              <dt style={{ color: "var(--tinta-suave)" }}>Ruta en Storage</dt>
              <dd style={{ margin: 0, fontFamily: "var(--mono)", fontSize: "0.85rem" }}>
                {doc.ruta_storage}
              </dd>
              <dt style={{ color: "var(--tinta-suave)" }}>Hash del contenido</dt>
              <dd style={{ margin: 0, fontFamily: "var(--mono)", fontSize: "0.8rem", wordBreak: "break-all" }}>
                {doc.hash_sha256 ?? "—"}
              </dd>
              <dt style={{ color: "var(--tinta-suave)" }}>Cargado</dt>
              <dd style={{ margin: 0 }}>{fechaLegible(doc.creado_en, true)}</dd>
            </dl>
          </div>
        </section>
      </main>
    </Armazon>
  );
}
