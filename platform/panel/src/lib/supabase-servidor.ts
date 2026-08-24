/**
 * Cliente de Supabase para el servidor: Server Components, Server Actions y
 * Route Handlers.
 *
 * DIFERENCIA CENTRAL CON EL BOT: acá se usa la clave ANÓNIMA, nunca la
 * `service_role`. La service_role pasa por encima de Row Level Security y da
 * lectura y escritura sobre toda la base, incluidos nombre, teléfono y
 * dirección de vecinos. En un Next.js cualquier variable puede terminar en el
 * bundle del navegador por un import distraído, así que la regla es simple: esa
 * clave no existe en este paquete.
 *
 * Lo que limita a cada persona a lo que puede ver es RLS, no este código. Las
 * políticas exigen `es_personal_panel()`, que consulta la tabla
 * `personal_panel`. Ver db/migraciones/017_cierra_acceso_autenticado.sql.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { configuracionSupabase } from "./configuracion.ts";

/**
 * Cliente para Server Components, Server Actions y Route Handlers.
 *
 * Lee y escribe la sesión en cookies. El `try/catch` del `setAll` no es
 * descuido: en un Server Component las cookies son de sólo lectura y Next lanza
 * si se intenta escribirlas. El refresco de la sesión lo hace el middleware,
 * que sí puede; acá se ignora el intento en silencio, que es lo que recomienda
 * la documentación de `@supabase/ssr`.
 */
export async function clienteServidor() {
  const { url, anon } = configuracionSupabase();
  const almacen = await cookies();

  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        return almacen.getAll();
      },
      setAll(nuevas) {
        try {
          for (const { name, value, options } of nuevas) {
            almacen.set(name, value, options);
          }
        } catch {
          // Server Component: no se pueden escribir cookies. El middleware ya
          // se encargó de refrescar la sesión.
        }
      },
    },
  });
}

export interface PersonaDelPanel {
  readonly usuarioId: string;
  readonly correo: string;
  readonly nombre: string | null;
  readonly rol: "operador" | "supervisor" | "admin";
}

/**
 * Quién está usando el panel, o null si no corresponde que entre.
 *
 * Dos condiciones, y las dos hacen falta: tener sesión en Supabase Auth Y estar
 * en el padrón `personal_panel` con `activo`. Estar en `auth.users` no alcanza
 * — ése fue exactamente el agujero que arregló la migración 017.
 *
 * Devolver null en vez de lanzar deja que cada pantalla decida qué mostrar.
 */
export async function personaActual(): Promise<PersonaDelPanel | null> {
  const supabase = await clienteServidor();

  // `getUser` y no `getSession`: getUser valida el token contra el servidor de
  // Auth. getSession sólo lee la cookie, que en el servidor no es de fiar.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("personal_panel")
    .select("usuario_id, correo, nombre, rol, activo")
    .eq("usuario_id", user.id)
    .maybeSingle();

  if (!data || data.activo !== true) return null;

  return {
    usuarioId: data.usuario_id as string,
    correo: data.correo as string,
    nombre: (data.nombre as string | null) ?? null,
    rol: data.rol as PersonaDelPanel["rol"],
  };
}
