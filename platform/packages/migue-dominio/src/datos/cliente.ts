/**
 * Cliente de Supabase para el lado servidor (bot y worker).
 *
 * Usa la SERVICE_ROLE, que pasa por encima de RLS. Eso es correcto acá y
 * peligroso en cualquier otro lado: esta clave nunca debe llegar al panel ni
 * al navegador. El panel usa la clave anónima más Supabase Auth, y RLS es lo
 * que lo limita a lo que el personal municipal puede ver.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cliente: SupabaseClient | null = null;

export class ConfiguracionFaltanteError extends Error {
  constructor(claves: string[]) {
    super(
      `Faltan variables de entorno para conectar con Supabase: ${claves.join(", ")}.\n` +
        `En la VPS viven en /srv/bots/.secrets/migue.env`,
    );
    this.name = "ConfiguracionFaltanteError";
  }
}

/**
 * Devuelve el cliente compartido, creándolo la primera vez.
 *
 * Falla al arrancar si falta configuración, no en la primera consulta: es
 * mejor que el proceso muera y PM2 lo deje en `errored` que descubrirlo cuando
 * un vecino ya está esperando respuesta.
 */
export function obtenerCliente(): SupabaseClient {
  if (cliente) return cliente;

  const url = process.env["SUPABASE_URL"]?.trim();
  const clave = process.env["SUPABASE_SERVICE_ROLE_KEY"]?.trim();

  const faltantes: string[] = [];
  if (!url) faltantes.push("SUPABASE_URL");
  if (!clave) faltantes.push("SUPABASE_SERVICE_ROLE_KEY");
  if (faltantes.length > 0) throw new ConfiguracionFaltanteError(faltantes);

  cliente = createClient(url!, clave!, {
    auth: {
      // El bot no es un usuario: no hay sesión que persistir ni token que
      // refrescar. Sin esto, supabase-js intenta guardar sesión en un storage
      // que no existe del lado servidor.
      persistSession: false,
      autoRefreshToken: false,
    },
    db: { schema: "public" },
    global: {
      headers: {
        // Aparece en pg_stat_activity: permite saber qué proceso hizo cada
        // consulta cuando algo va lento.
        "x-application-name": process.env["BOT_NAME"] ?? "migue",
      },
    },
  });

  return cliente;
}

/** Sólo para pruebas: fuerza que el próximo `obtenerCliente` reconstruya. */
export function reiniciarCliente(): void {
  cliente = null;
}

/** Chequeo de conectividad para el endpoint /readyz. */
export async function verificarConexion(): Promise<boolean> {
  const { error } = await obtenerCliente()
    .from("configuracion")
    .select("clave", { count: "exact", head: true });
  return error === null;
}
