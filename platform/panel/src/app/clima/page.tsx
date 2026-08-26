import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Clima, type VotoConContexto } from "./Clima";
import { LIMITE_FILAS } from "@/lib/metricas";

export const dynamic = "force-dynamic";

/**
 * Clima: si Migue ayudó o no, según el vecino.
 *
 * Es la única pantalla del panel donde el dato no es una inferencia nuestra:
 * el vecino tocó un pulgar. Todo lo demás —cuántos mensajes, de qué hablaron,
 * si encontró material— lo deducimos mirando lo que hizo el bot.
 *
 * NO duplica Conversaciones. Ahí se ve el resumen por conversación y hay que
 * abrir cada transcripción de a una para leer un comentario; acá está cada voto
 * con la respuesta que valoró al lado, que es la unidad en la que se trabaja:
 * un pulgar abajo es una respuesta para corregir, no una charla para leer.
 *
 * El comentario sale de `valoraciones.comentario`, que hasta ahora el panel no
 * consultaba: por `v_conversaciones` sólo llegaba `ultimo_comentario`, uno por
 * conversación, así que con dos votos negativos en la misma charla el primero
 * era invisible.
 */
export default async function PaginaClima() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  // Se traen el mensaje valorado y la conversación en la misma consulta, por la
  // clave foránea. `mensajes.texto` es LO QUE MIGUE CONTESTÓ: sin eso la
  // pantalla sería una lista de pulgares sin objeto, que no le sirve a nadie.
  //
  // De `conversaciones` se piden sólo el nombre y el canal. `canal_usuario_id`
  // NO se pide a propósito: en WhatsApp es el teléfono del vecino, y la
  // migración 023 lo sacó de la vista justamente para que no viajara a cada
  // navegador que abre una lista.
  const { data, error } = await supabase
    .from("valoraciones")
    .select(
      "id, voto, sobre, comentario, creado_en, conversacion_id, mensajes(texto), conversaciones(nombre_usuario, canal)",
    )
    .order("creado_en", { ascending: false })
    .limit(LIMITE_FILAS)
    .returns<VotoConContexto[]>();

  return (
    <Armazon persona={persona} actual="/clima">
      <main>
        <div className="titulo-pagina">
          <h1>Clima</h1>
        </div>
        <p className="bajada">
          Si a los vecinos les sirvió lo que Migue contestó, dicho por ellos. Es el único dato del
          panel que no es una deducción nuestra — y los pulgares abajo con comentario son la lista
          de trabajo más directa que hay.
        </p>

        {error && <div className="aviso mal">No pude leer los votos: {error.message}</div>}

        <Clima votos={data ?? []} />
      </main>
    </Armazon>
  );
}
