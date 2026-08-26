import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Metricas } from "./Metricas";
import { LIMITE_FILAS, type ConversacionMedida, type MensajeMedido } from "@/lib/metricas";
import type { Ticket } from "@/lib/tipos";

export const dynamic = "force-dynamic";

/**
 * Métricas: ¿Migue está sirviendo?
 *
 * Todo se calcula en este componente y en `lib/metricas.ts`, sobre las filas
 * traídas. No hay agregados en SQL por dos razones: los de PostgREST están
 * deshabilitados en este proyecto (400 PGRST123), y aunque funcionaran,
 * «cerrado» y «heredado» ya están definidos en `tipos.ts` con pruebas —
 * reimplementarlos en SQL es cómo nacieron los dos números contradictorios que
 * esta base ya tuvo.
 *
 * Con los volúmenes de hoy —18 mensajes, 20 tickets, 97 fragmentos— traer todo
 * cuesta nada. `LIMITE_FILAS` marca dónde deja de ser razonable, y la pantalla
 * avisa cuando lo alcanza en vez de presentar un parcial como el total.
 */
export default async function PaginaMetricas() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  const [conversaciones, mensajes, tickets, documentos, trabajos, config] = await Promise.all([
    supabase
      .from("conversaciones")
      .select("id, canal, canal_usuario_id, estado, cantidad_mensajes, iniciada_en, ultima_actividad_en")
      .order("iniciada_en", { ascending: false })
      .limit(LIMITE_FILAS)
      .returns<ConversacionMedida[]>(),

    supabase
      .from("mensajes")
      .select(
        "direccion, texto, media_tipo, intencion, confianza, origen_respuesta, modelo, tokens_entrada, tokens_salida, costo_usd, latencia_ms, fragmentos_citados, conversacion_id, creado_en",
      )
      .order("creado_en", { ascending: false })
      .limit(LIMITE_FILAS)
      .returns<MensajeMedido[]>(),

    supabase.from("tickets").select("*").limit(LIMITE_FILAS).returns<Ticket[]>(),

    supabase
      .from("documentos")
      .select("id, titulo, cantidad_fragmentos")
      .eq("activo", true)
      .order("titulo"),

    supabase
      .from("trabajos")
      .select("estado, intentos, error_detalle, creado_en")
      .limit(LIMITE_FILAS),

    supabase.from("configuracion").select("clave, valor").eq("clave", "conversacion_ventana_horas"),
  ]);

  const error =
    conversaciones.error ?? mensajes.error ?? tickets.error ?? documentos.error ?? trabajos.error;

  // Para atribuir un fragmento citado a su documento hace falta el mapa
  // fragmento → documento. Se piden SÓLO los ids que se citaron alguna vez, no
  // los 97: la lista de citados es chica por definición.
  const idsCitados = [
    ...new Set((mensajes.data ?? []).flatMap((m) => m.fragmentos_citados ?? [])),
  ];
  const fragmentoADocumento = new Map<string, string>();
  if (idsCitados.length > 0) {
    const { data } = await supabase
      .from("fragmentos")
      .select("id, documento_id")
      .in("id", idsCitados);
    for (const f of data ?? []) {
      fragmentoADocumento.set(f.id as string, f.documento_id as string);
    }
  }

  const { count: fragmentosTotales } = await supabase
    .from("fragmentos")
    .select("id", { count: "exact", head: true });

  const ventanaHoras = Number(
    (config.data ?? []).find((c) => c.clave === "conversacion_ventana_horas")?.valor ?? 24,
  );

  return (
    <Armazon persona={persona} actual="/metricas">
      <main>
        <div className="titulo-pagina">
          <h1>Métricas</h1>
        </div>
        <p className="bajada">
          Si Migue está sirviendo, y a cuánta gente. Lo que no se puede medir todavía está listado
          al final, con el motivo: es información igual de útil que un número.
        </p>

        {error && <div className="aviso mal">No pude leer todo: {error.message}</div>}

        <Metricas
          conversaciones={conversaciones.data ?? []}
          mensajes={mensajes.data ?? []}
          tickets={tickets.data ?? []}
          documentos={(documentos.data ?? []) as { id: string; titulo: string; cantidad_fragmentos: number }[]}
          fragmentosTotales={fragmentosTotales ?? 0}
          fragmentoADocumento={[...fragmentoADocumento.entries()]}
          trabajos={
            (trabajos.data ?? []) as {
              estado: string;
              intentos: number;
              error_detalle: string | null;
              creado_en: string;
            }[]
          }
          ventanaHoras={ventanaHoras}
          alcanzoElLimite={(mensajes.data ?? []).length >= LIMITE_FILAS}
        />
      </main>
    </Armazon>
  );
}
