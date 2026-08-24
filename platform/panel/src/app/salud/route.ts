/**
 * Chequeo de salud para nginx y PM2.
 *
 * No toca la base a propósito: responde si el proceso de Next está vivo, que es
 * lo que tiene que decidir un reinicio automático. Mezclarlo con la conexión a
 * Supabase haría que un corte de Supabase reinicie el panel en bucle sin que el
 * panel tenga nada roto.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return new Response("ok\n", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
