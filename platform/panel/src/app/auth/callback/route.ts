/**
 * Vuelta del enlace de acceso: cambia el código por una sesión.
 *
 * Supabase manda al usuario acá con un `code` en la query. Este handler lo
 * canjea por una sesión y deja las cookies puestas. Es un Route Handler y no un
 * Server Component porque necesita ESCRIBIR cookies, y un Server Component no
 * puede.
 */
import { NextResponse, type NextRequest } from "next/server";
import { clienteServidor } from "@/lib/supabase-servidor";

export async function GET(pedido: NextRequest) {
  const { searchParams, origin } = pedido.nextUrl;
  const codigo = searchParams.get("code");

  const irA = (ruta: string) => NextResponse.redirect(new URL(ruta, origin));

  if (!codigo) return irA("/ingresar?error=sin-codigo");

  const supabase = await clienteServidor();
  const { error } = await supabase.auth.exchangeCodeForSession(codigo);
  if (error) return irA("/ingresar?error=enlace-vencido");

  // Se vuelve a donde el usuario quería ir antes del login. Se valida que sea
  // una ruta interna: sin esto, un `volver=https://otro-sitio` convierte al
  // panel en un redirector abierto, útil para hacer pasar un enlace de phishing
  // por un enlace del municipio.
  const volver = searchParams.get("volver") ?? "/";
  const destino = volver.startsWith("/") && !volver.startsWith("//") ? volver : "/";

  return irA(destino);
}
