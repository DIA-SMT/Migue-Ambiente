import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Respuestas } from "./Respuestas";
import type { Faq, RespuestaFija } from "@/lib/tipos";

export const dynamic = "force-dynamic";

export default async function PaginaRespuestas() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  // Los borradores primero: son los que necesitan que alguien haga algo.
  const { data: faqs, error: errorFaqs } = await supabase
    .from("faqs")
    .select("*")
    .order("activa", { ascending: true })
    .order("veces_usada", { ascending: false })
    .returns<Faq[]>();

  const { data: fijas, error: errorFijas } = await supabase
    .from("respuestas_fijas")
    .select("*")
    .order("activa", { ascending: true })
    .order("veces_usada", { ascending: false })
    .returns<RespuestaFija[]>();

  // Cuántos mensajes de vecinos hay con los que comparar un disparador. Con
  // pocos, la prueba contra mensajes reales no concluye nada y conviene decirlo
  // en vez de mostrar un número que no significa lo que parece.
  const { count: mensajesEntrantes } = await supabase
    .from("mensajes")
    .select("id", { count: "exact", head: true })
    .eq("direccion", "entrante");

  return (
    <Armazon persona={persona} actual="/faqs">
      <main>
        <div className="titulo-pagina">
          <h1>Respuestas</h1>
        </div>
        <p className="bajada">
          Lo que escribe el área pesa el doble que un fragmento de PDF cuando Migue busca con qué
          responder. Es la forma más directa de mejorar lo que contesta.
        </p>

        {(errorFaqs ?? errorFijas) && (
          <div className="aviso mal">
            No pude leer las respuestas: {(errorFaqs ?? errorFijas)?.message}
          </div>
        )}

        <Respuestas
          faqs={faqs ?? []}
          fijas={fijas ?? []}
          puedePublicar={persona.rol === "admin" || persona.rol === "supervisor"}
          mensajesEntrantes={mensajesEntrantes ?? 0}
        />
      </main>
    </Armazon>
  );
}
