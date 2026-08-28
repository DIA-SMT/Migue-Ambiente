import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Interacciones, type MensajeDeLista } from "./Interacciones";
import { LIMITE_FILAS } from "@/lib/metricas";
import type { Conversacion } from "@/lib/tipos";

export const dynamic = "force-dynamic";

/**
 * Qué le preguntan a Migue, una fila por consulta.
 *
 * Este archivo sólo TRAE filas. El emparejamiento de cada pregunta con la
 * respuesta que le siguió se hace en el componente, que es la misma división que
 * ya tienen el tablero y Métricas: los agregados de PostgREST están
 * deshabilitados en este proyecto y la lógica se prueba mejor en TypeScript.
 *
 * Se traen los mensajes en los DOS sentidos aunque la lista muestre sólo los
 * entrantes: la traza —qué intención se leyó, de dónde salió la respuesta— viaja
 * en el saliente, así que sin ellos las dos últimas columnas quedarían vacías.
 */
export default async function PaginaInteracciones() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  const [mensajes, conversaciones] = await Promise.all([
    supabase
      .from("mensajes")
      .select("id, conversacion_id, direccion, texto, media_tipo, intencion, origen_respuesta, creado_en")
      .order("creado_en", { ascending: false })
      .limit(LIMITE_FILAS)
      .returns<MensajeDeLista[]>(),

    // `v_conversaciones` y no la tabla: la vista es la que NO trae
    // `canal_usuario_id`, que en WhatsApp es el teléfono del vecino.
    supabase
      .from("v_conversaciones")
      .select("*")
      .order("ultima_actividad_en", { ascending: false })
      .limit(LIMITE_FILAS)
      .returns<Conversacion[]>(),
  ]);

  const problema = mensajes.error ?? conversaciones.error ?? null;

  return (
    <Armazon persona={persona} actual="/interacciones">
      <main>
        <div className="titulo-pagina">
          <h1>Interacciones</h1>
        </div>
        <p className="bajada">
          Qué le preguntan a Migue, una fila por consulta y en orden de llegada. Es la lista que
          dice qué conocimiento falta cargar: si algo aparece seguido con «no supo», es una
          pregunta frecuente esperando a que alguien la escriba. Hacé clic en una consulta para ver
          la charla completa y qué contestó.
        </p>

        {problema && (
          <div className="aviso mal">No pude leer las consultas: {problema.message}</div>
        )}

        <Interacciones
          mensajes={mensajes.data ?? []}
          conversaciones={conversaciones.data ?? []}
          alcanzoElLimite={(mensajes.data ?? []).length >= LIMITE_FILAS}
        />
      </main>
    </Armazon>
  );
}
