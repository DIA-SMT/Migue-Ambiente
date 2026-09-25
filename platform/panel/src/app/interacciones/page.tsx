import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Interacciones, type MensajeDeLista } from "./Interacciones";
import { LIMITE_FILAS } from "@/lib/metricas";
import type { Conversacion } from "@/lib/tipos";

export const dynamic = "force-dynamic";

/**
 * Qué le preguntan a Migue, una fila por consulta, con la charla adentro.
 *
 * Reemplazó a dos pantallas: esta y «Conversaciones». El porqué está en el
 * componente; acá basta con que `/conversaciones` ahora redirige a esta ruta.
 *
 * Este archivo sólo TRAE filas. El emparejamiento de cada pregunta con la
 * respuesta que le siguió se hace en el componente, que es la misma división que
 * ya tienen el tablero y Métricas: los agregados de PostgREST están
 * deshabilitados en este proyecto y la lógica se prueba mejor en TypeScript.
 *
 * Se traen los mensajes en los DOS sentidos aunque la lista muestre sólo los
 * entrantes: la traza —qué intención se leyó, de dónde salió la respuesta— viaja
 * en el saliente, así que sin ellos las dos últimas columnas quedarían vacías.
 *
 * Los MENSAJES de la charla no se traen acá: los pide el desplegado, uno por
 * vez, con una acción de servidor. Traerlos todos sería bajarse la bitácora
 * entera del bot en cada carga de la pantalla.
 */
export default async function PaginaInteracciones({
  searchParams,
}: {
  searchParams: Promise<{ abrir?: string }>;
}) {
  // `abrir` llega desde Clima y desde Alertas: se hace clic en un pulgar abajo y
  // esta pantalla despliega directamente esa charla. Se resuelve acá, en el
  // servidor, y baja como prop: leerlo en el cliente con `useSearchParams`
  // obligaría a un `<Suspense>` alrededor de toda la lista a cambio de nada.
  const { abrir } = await searchParams;
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
          pregunta frecuente esperando a que alguien la escriba. Hacé clic en una consulta y se
          despliega ahí mismo la charla completa, con lo que contestó Migue y cómo le fue al
          vecino.
        </p>

        {problema && (
          <div className="aviso mal">No pude leer las consultas: {problema.message}</div>
        )}

        <Interacciones
          mensajes={mensajes.data ?? []}
          conversaciones={conversaciones.data ?? []}
          alcanzoElLimite={(mensajes.data ?? []).length >= LIMITE_FILAS}
          abrirConversacion={abrir}
        />
      </main>
    </Armazon>
  );
}
