import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Casos } from "./Casos";
import type { SolicitudPrograma, Ticket } from "@/lib/tipos";

export const dynamic = "force-dynamic";

/**
 * La bandeja del día.
 *
 * Es la pantalla que el área abre todas las mañanas, así que lo primero que
 * tiene que contestar es «¿qué se está por vencer?». Por eso el orden por
 * defecto es por urgencia contra el plazo y no por fecha de creación: el plazo
 * es una promesa que el bot ya le hizo a un vecino, con fecha concreta.
 */
export default async function PaginaCasos() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  // Se traen los últimos 200 y se ordenan por urgencia en el cliente. El orden
  // por urgencia no se puede expresar en SQL sin duplicar la lógica de
  // `situacionSla`, y duplicarla haría que la lista y el chip de cada fila
  // pudieran discrepar.
  const { data: tickets, error: errorT } = await supabase
    .from("tickets")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200)
    .returns<Ticket[]>();

  const { data: solicitudes, error: errorS } = await supabase
    .from("program_requests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200)
    .returns<SolicitudPrograma[]>();

  return (
    <Armazon persona={persona} actual="/casos">
      <main>
        <div className="titulo-pagina">
          <h1>Pedidos y reclamos</h1>
        </div>
        <p className="bajada">
          Lo que los vecinos pidieron a través de Migue. Ordenado por lo que está más cerca de
          vencer: el plazo no es una meta interna, es una fecha que el bot ya le prometió a alguien.
        </p>

        {(errorT ?? errorS) && (
          <div className="aviso mal">No pude leer los casos: {(errorT ?? errorS)?.message}</div>
        )}

        <Casos tickets={tickets ?? []} solicitudes={solicitudes ?? []} />
      </main>
    </Armazon>
  );
}
