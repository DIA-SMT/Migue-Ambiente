import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Conversaciones } from "./Conversaciones";
import type { Conversacion } from "@/lib/tipos";

export const dynamic = "force-dynamic";

export default async function PaginaConversaciones({
  searchParams,
}: {
  searchParams: Promise<{ abrir?: string }>;
}) {
  // `abrir` llega desde Clima: se hace clic en un pulgar abajo y esta pantalla
  // abre directamente esa charla. Se resuelve acá, en el servidor, y baja como
  // prop: leerlo en el cliente con `useSearchParams` obligaría a un `<Suspense>`
  // alrededor de toda la lista a cambio de nada.
  const { abrir } = await searchParams;
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  // Se ordena por actividad y NO por «las que fallaron primero», aunque esa sea
  // la lista de trabajo. Motivo: esta pantalla se usa de dos maneras —«¿cómo
  // viene hoy?» y «¿dónde falló?»— y el orden cronológico es el único que sirve
  // para la primera. El reordenamiento por falla lo hace el filtro, del lado del
  // cliente, sobre estas mismas filas.
  const { data: conversaciones, error } = await supabase
    .from("v_conversaciones")
    .select("*")
    .order("ultima_actividad_en", { ascending: false })
    .limit(200)
    .returns<Conversacion[]>();

  return (
    <Armazon persona={persona} actual="/conversaciones">
      <main>
        <div className="titulo-pagina">
          <h1>Conversaciones</h1>
        </div>
        <p className="bajada">
          Con quién habló Migue y cómo le fue. Cuando el vecino toca el pulgar, el voto queda acá — y
          si tocó el pulgar abajo, también lo que dijo que le faltaba.
        </p>

        {error && (
          <div className="aviso mal">No pude leer las conversaciones: {error.message}</div>
        )}

        <Conversaciones conversaciones={conversaciones ?? []} abrirId={abrir} />
      </main>
    </Armazon>
  );
}
