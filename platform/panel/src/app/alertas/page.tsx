import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Alertas } from "./Alertas";
import type { AlertaAsesor } from "@/lib/tipos";

export const dynamic = "force-dynamic";

interface PersonaNombre {
  usuario_id: string;
  nombre: string | null;
  rol: string;
}

/**
 * Vecinos que pidieron hablar con una persona.
 *
 * Cada fila pendiente es alguien esperando un llamado. Migue ya le pidió el
 * teléfono al registrar el pedido —en Telegram no hay ningún otro dato de
 * contacto—, así que lo que queda es humano: llamar, y marcar la alerta como
 * atendida para que el resto del área sepa que ya está.
 */
export default async function PaginaAlertas() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  const { data: alertas, error } = await supabase
    .from("alertas_asesor")
    .select("*")
    .order("creado_en", { ascending: false })
    .limit(200)
    .returns<AlertaAsesor[]>();

  // `atendida_por` es un uuid sin foreign key (patrón revisada_por): PostgREST
  // no lo puede embeber, así que los nombres se traen aparte y se mapean.
  const { data: personasCrudo } = await supabase.rpc("personal_nombres");
  const nombres = new Map(
    ((personasCrudo ?? []) as PersonaNombre[]).map((p) => [p.usuario_id, p.nombre ?? "—"]),
  );

  return (
    <Armazon persona={persona} actual="/alertas">
      <main>
        <div className="titulo-pagina">
          <h1>Pedidos de asesor</h1>
        </div>
        <p className="bajada">
          Vecinos que le pidieron a Migue hablar con una persona. Si dictaron un teléfono, están
          esperando el llamado; si no, la respuesta les llega por el mismo chat.
        </p>

        {error && <div className="aviso mal">No pude leer las alertas: {error.message}</div>}

        <Alertas
          alertas={alertas ?? []}
          atendidoPor={Object.fromEntries(nombres)}
        />
      </main>
    </Armazon>
  );
}
