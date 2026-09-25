import { redirect, permanentRedirect } from "next/navigation";

/**
 * «Conversaciones» ya no existe como pantalla: se unificó con Interacciones.
 *
 * La ruta se queda igual, redirigiendo, y no se borra. Motivo: `?abrir=<id>` es
 * el enlace que llevaba de un pulgar abajo en Clima —y de una alerta— a la
 * charla completa. Esos enlaces ya están escritos en la base y en pantallas que
 * alguien puede tener abiertas; borrar la ruta los convertiría en un 404 el día
 * del despliegue, que es exactamente el tipo de rotura silenciosa que el panel
 * no debería tener.
 *
 * Los enlaces del propio panel se actualizaron para ir derecho a Interacciones.
 * Esto es la red para lo que quedó afuera.
 */
export default async function PaginaConversaciones({
  searchParams,
}: {
  searchParams: Promise<{ abrir?: string }>;
}) {
  const { abrir } = await searchParams;
  // `permanentRedirect` para que el navegador aprenda el destino y deje de
  // pedir la vieja. Sin `abrir` no hay nada que conservar y alcanza con llevar a
  // la lista.
  if (abrir === undefined || abrir === "") permanentRedirect("/interacciones");
  redirect(`/interacciones?abrir=${encodeURIComponent(abrir)}`);
}
