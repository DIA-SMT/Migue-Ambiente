import { personaActual } from "@/lib/supabase-servidor";

/**
 * Dinámica y no estática: el contenido depende de la cookie de sesión de quien
 * pide la página, así que no hay nada que pre-renderizar. Sin esto, el build
 * intenta generarla de antemano, no encuentra las variables de Supabase y falla
 * — y aunque las encontrara, serviría a todo el mundo la misma página cacheada.
 */
export const dynamic = "force-dynamic";

/**
 * Portada del panel.
 *
 * Por ahora sólo confirma quién entró y con qué rol: es lo que hace falta para
 * verificar que la cadena Auth + padrón + RLS funciona de punta a punta. Las
 * secciones se agregan encima de esto.
 */
export default async function Inicio() {
  const persona = await personaActual();

  // Tener sesión no alcanza: hay que estar en el padrón. El middleware ya
  // mandó al login a quien no tiene sesión, así que si llegó acá sin persona es
  // porque su cuenta existe pero no está habilitada.
  if (!persona) {
    return (
      <main>
        <h1>Cuenta sin habilitar</h1>
        <p>
          Tu cuenta existe pero todavía no está habilitada para usar el panel. Pedile a un
          administrador que te agregue.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Panel de Migue Ambiente</h1>
      <p>
        Sesión de <strong>{persona.nombre ?? persona.correo}</strong> ({persona.rol}).
      </p>
      <p>Las secciones se agregan acá.</p>
    </main>
  );
}
