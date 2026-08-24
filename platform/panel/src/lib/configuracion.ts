/**
 * Lectura de la configuración de Supabase.
 *
 * Sin dependencias de Next, para que la puedan usar tanto el cliente de
 * navegador como el de servidor sin arrastrarse entre sí.
 */
export interface ConfiguracionSupabase {
  readonly url: string;
  readonly anon: string;
}

export function configuracionSupabase(): ConfiguracionSupabase {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const anon = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  // Falla temprano y con un mensaje que dice qué falta. Sin esto el síntoma es
  // un «Invalid API key» en el navegador que no explica nada.
  if (!url || !anon) {
    const faltan = [
      !url ? "NEXT_PUBLIC_SUPABASE_URL" : null,
      !anon ? "NEXT_PUBLIC_SUPABASE_ANON_KEY" : null,
    ].filter(Boolean);
    throw new Error(
      `Faltan variables de entorno del panel: ${faltan.join(", ")}. ` +
        `En desarrollo van en panel/.env.local; en la VPS, en /srv/bots/.secrets/panel.env`,
    );
  }
  return { url, anon };
}
