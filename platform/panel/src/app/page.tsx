import { redirect } from "next/navigation";
import { personaActual } from "@/lib/supabase-servidor";

/**
 * La portada no tiene contenido propio: manda a la primera sección.
 *
 * Cuando haya más secciones puede convertirse en un tablero, pero inventar un
 * tablero con una sola sección construida sería una pantalla vacía con aire de
 * estar terminada.
 */
export const dynamic = "force-dynamic";

export default async function Inicio() {
  const persona = await personaActual();

  // El middleware ya mandó al login a quien no tiene sesión. Si llegó acá sin
  // persona, es que su cuenta existe pero no está en el padrón.
  if (!persona) {
    return (
      <div className="pantalla-centrada">
        <div className="caja-ingreso">
          <h1>Cuenta sin habilitar</h1>
          <p>
            Tu cuenta existe pero todavía no está habilitada para usar el panel. Pedile a un
            administrador que te agregue.
          </p>
        </div>
      </div>
    );
  }

  redirect("/documentos");
}
