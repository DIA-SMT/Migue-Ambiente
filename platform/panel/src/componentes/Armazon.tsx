import Link from "next/link";
import type { PersonaDelPanel } from "@/lib/supabase-servidor";
import { Salir } from "./Salir";
import {
  Hojas,
  IconoCasos,
  IconoDocumentos,
  IconoMetricas,
  IconoPersonal,
  IconoReglas,
  IconoRespuestas,
  IconoSinRespuesta,
  IconoTextos,
} from "./Botanica";

/**
 * El armazón del panel: barra lateral fija más el área de contenido.
 *
 * Las secciones se agrupan por para qué sirven, no por qué tabla tocan. «Lo que
 * Migue sabe» junta documentos, respuestas y textos porque son las tres formas
 * de cambiar lo que el bot contesta; «El día a día» junta lo que se mira todas
 * las mañanas. Un menú plano de siete ítems obliga a leerlos todos cada vez.
 *
 * Las que todavía no existen se listan igual, atenuadas y sin enlace: el área ve
 * el alcance completo de lo que el panel va a administrar, y no parece que
 * falten cosas por olvido.
 */
const GRUPOS = [
  {
    rotulo: "Lo que Migue sabe",
    items: [
      { href: "/documentos", texto: "Documentos", Icono: IconoDocumentos, listo: true },
      { href: "/faqs", texto: "Respuestas", Icono: IconoRespuestas, listo: false },
      { href: "/textos", texto: "Textos del bot", Icono: IconoTextos, listo: false },
      { href: "/reglas", texto: "Reglas", Icono: IconoReglas, listo: false },
    ],
  },
  {
    rotulo: "El día a día",
    items: [
      { href: "/casos", texto: "Pedidos y reclamos", Icono: IconoCasos, listo: false },
      { href: "/sin-respuesta", texto: "No supo responder", Icono: IconoSinRespuesta, listo: false },
      { href: "/metricas", texto: "Métricas", Icono: IconoMetricas, listo: false },
    ],
  },
  {
    rotulo: "Administración",
    items: [{ href: "/personal", texto: "Personal", Icono: IconoPersonal, listo: false }],
  },
] as const;

export function Armazon({
  persona,
  actual,
  children,
}: {
  persona: PersonaDelPanel;
  actual: string;
  children: React.ReactNode;
}) {
  return (
    <div className="armazon">
      <aside className="barra">
        <div className="barra-marca">
          <div className="nombre">
            Migue <em>Ambiente</em>
          </div>
          <div className="area">Dirección de Ambiente · SMT</div>
        </div>

        <nav className="barra-nav" aria-label="Secciones del panel">
          {GRUPOS.map((grupo) => (
            <div key={grupo.rotulo}>
              <div className="rotulo-grupo">{grupo.rotulo}</div>
              {grupo.items.map(({ href, texto, Icono, listo }) =>
                listo ? (
                  <Link
                    key={href}
                    href={href}
                    aria-current={actual.startsWith(href) ? "page" : undefined}
                  >
                    <Icono className="icono" />
                    {texto}
                  </Link>
                ) : (
                  <div key={href} className="pendiente" title="Todavía no construida">
                    <Icono className="icono" />
                    {texto}
                  </div>
                ),
              )}
            </div>
          ))}
        </nav>

        <div className="barra-pie">
          <div className="quien">
            <strong>{persona.nombre ?? persona.correo}</strong>
            <span>{persona.rol}</span>
          </div>
          <Salir />
        </div>

        <Hojas className="barra-hojas" />
      </aside>

      <div className="contenido">{children}</div>
    </div>
  );
}
