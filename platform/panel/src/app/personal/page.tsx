import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Personal } from "./Personal";
import type { Persona } from "@/lib/tipos";

export const dynamic = "force-dynamic";

/**
 * Quién entra al panel.
 *
 * Es la pantalla que administra el padrón que la migración 017 creó para cerrar
 * un agujero real: cualquiera podía registrarse en Supabase y leer datos de
 * vecinos. Estar en `auth.users` no alcanza — hay que estar en esta tabla.
 *
 * La política `personal_se_ve` deja que cada uno vea SU fila y que un admin vea
 * todas. O sea que un operador que entre acá va a ver una sola línea, la propia,
 * y eso es correcto: no tiene por qué saber quién más tiene acceso.
 */
export default async function PaginaPersonal() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  const { data: padron, error } = await supabase
    .from("personal_panel")
    .select("*")
    // Los activos primero, y dentro de cada grupo los de más permiso arriba: es
    // el orden en el que uno revisa «quién puede publicar».
    .order("activo", { ascending: false })
    .order("rol")
    .order("nombre")
    .returns<Persona[]>();

  const esAdmin = persona.rol === "admin";

  return (
    <Armazon persona={persona} actual="/personal">
      <main>
        <div className="titulo-pagina">
          <h1>Personal</h1>
        </div>
        <p className="bajada">
          Quién puede entrar al panel y qué puede hacer. Tener una cuenta de Supabase no alcanza:
          hay que estar en esta lista.
        </p>

        {error && <div className="aviso mal">No pude leer el padrón: {error.message}</div>}

        {!esAdmin && (
          <div className="aviso info">
            Tu rol es <strong>{persona.rol}</strong>, así que sólo ves tu propia línea. Administrar
            quién entra es una acción de administrador.
          </div>
        )}

        <Personal
          padron={padron ?? []}
          yoSoy={persona.usuarioId}
          esAdmin={esAdmin}
        />
      </main>
    </Armazon>
  );
}
