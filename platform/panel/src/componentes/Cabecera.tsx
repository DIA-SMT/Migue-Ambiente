import Link from "next/link";
import type { PersonaDelPanel } from "@/lib/supabase-servidor";

/**
 * Cabecera con la navegación y quién está usando el panel.
 *
 * Las secciones se listan todas, incluidas las que todavía no existen, con
 * `disponible: false`. Es deliberado: el área ve el alcance completo de lo que
 * el panel va a administrar, y no parece que falten cosas por olvido.
 */
const SECCIONES = [
  { href: "/documentos", texto: "Documentos", disponible: true },
  { href: "/faqs", texto: "Respuestas", disponible: false },
  { href: "/textos", texto: "Textos del bot", disponible: false },
  { href: "/reglas", texto: "Reglas", disponible: false },
  { href: "/casos", texto: "Pedidos y reclamos", disponible: false },
  { href: "/sin-respuesta", texto: "No supo responder", disponible: false },
  { href: "/metricas", texto: "Métricas", disponible: false },
] as const;

export function Cabecera({ persona, actual }: { persona: PersonaDelPanel; actual: string }) {
  return (
    <header className="cabecera">
      <div className="cabecera-interior">
        <div className="marca">
          Migue <span>Ambiente</span>
        </div>

        <nav className="nav" aria-label="Secciones">
          {SECCIONES.filter((s) => s.disponible).map((s) => (
            <Link
              key={s.href}
              href={s.href}
              aria-current={actual.startsWith(s.href) ? "page" : undefined}
            >
              {s.texto}
            </Link>
          ))}
          {SECCIONES.filter((s) => !s.disponible).map((s) => (
            <span
              key={s.href}
              className="nav-pendiente"
              title="Todavía no construida"
              style={{ padding: "7px 12px", color: "var(--tinta-suave)", opacity: 0.5, fontSize: "0.92rem", whiteSpace: "nowrap" }}
            >
              {s.texto}
            </span>
          ))}
        </nav>

        <div className="sesion">
          <strong>{persona.nombre ?? persona.correo}</strong>
          {persona.rol}
        </div>
      </div>
    </header>
  );
}
