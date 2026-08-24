/**
 * Proxy: refresca la sesión y manda al login a quien no la tiene.
 *
 * Se llama `proxy.ts` y no `middleware.ts` porque Next 16 renombró la
 * convención y avisa en cada build que la vieja está deprecada.
 *
 * QUÉ ES Y QUÉ NO ES ESTO. No es el control de seguridad. Lo que protege los
 * datos de los vecinos es Row Level Security en Supabase: aunque alguien
 * llegara a una pantalla sin permiso, las consultas le devolverían cero filas,
 * porque las políticas exigen `es_personal_panel()`. Este middleware es
 * comodidad de navegación —que veas el login en vez de una pantalla vacía— y un
 * lugar donde refrescar el token antes de que expire.
 *
 * Confundir las dos cosas es el error clásico: un middleware que «protege» el
 * panel mientras la base deja leer todo al primero que se registre. Eso fue,
 * literalmente, el agujero que cerró la migración 017.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Rutas que se sirven sin sesión. Todo lo demás la exige. */
const PUBLICAS = ["/ingresar", "/salud"];

export async function proxy(pedido: NextRequest) {
  let respuesta = NextResponse.next({ request: pedido });

  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const anon = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  // Sin configuración no se puede decidir nada. Se deja pasar para que la
  // página muestre el error de configuración, que es más útil que un redirect
  // en bucle hacia un login que tampoco va a funcionar.
  if (!url || !anon) return respuesta;

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return pedido.cookies.getAll();
      },
      setAll(nuevas) {
        for (const { name, value } of nuevas) {
          pedido.cookies.set(name, value);
        }
        respuesta = NextResponse.next({ request: pedido });
        for (const { name, value, options } of nuevas) {
          respuesta.cookies.set(name, value, options);
        }
      },
    },
  });

  // Esta llamada es la que refresca el token si está por vencer, y por eso va
  // acá y no en cada página: el middleware puede escribir cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const ruta = pedido.nextUrl.pathname;
  const esPublica = PUBLICAS.some((p) => ruta === p || ruta.startsWith(`${p}/`));

  if (!user && !esPublica) {
    const destino = pedido.nextUrl.clone();
    destino.pathname = "/ingresar";
    // Se recuerda a dónde quería ir, para volver ahí después de entrar.
    destino.searchParams.set("volver", ruta);
    return NextResponse.redirect(destino);
  }

  if (user && ruta === "/ingresar") {
    const destino = pedido.nextUrl.clone();
    destino.pathname = "/";
    destino.search = "";
    return NextResponse.redirect(destino);
  }

  return respuesta;
}

export const config = {
  // Se excluyen los assets: hacer una consulta a Auth por cada ícono sería
  // gastar latencia y cuota para nada.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
