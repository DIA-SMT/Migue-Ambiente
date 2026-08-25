import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Respuestas } from "./Respuestas";
import type { Faq, PreguntaSinResponder, RespuestaFija, TextoBot } from "@/lib/tipos";

export const dynamic = "force-dynamic";

/**
 * Cómo se agrupan las frases fijas del bot.
 *
 * Por flujo y no alfabéticamente: quien viene a corregir el mensaje de
 * confirmación de un retiro quiere ver los otros mensajes de ese mismo flujo al
 * lado, para que el tono no quede desparejo.
 *
 * Toda clave que no esté en ningún grupo cae en «sinAgrupar» y se muestra igual.
 * Eso es a propósito: una clave nueva que alguien agregue por SQL tiene que
 * aparecer en la pantalla sin que haya que tocar este archivo, porque si no
 * queda un mensaje que el bot envía y el panel no muestra.
 */
const GRUPOS: { rotulo: string; explicacion: string; claves: string[] }[] = [
  {
    rotulo: "Primer contacto",
    explicacion: "Lo primero que ve alguien que le escribe a Migue.",
    claves: ["bienvenida", "menu_principal"],
  },
  {
    rotulo: "Retiro de residuos no habituales",
    explicacion: "Escombros, poda, muebles. El flujo con foto obligatoria.",
    claves: [
      "retiro_requisitos",
      "retiro_pedir_tipo",
      "retiro_pedir_foto",
      "retiro_foto_faltante",
      "retiro_pedir_direccion",
      "retiro_confirmacion",
    ],
  },
  {
    rotulo: "Reclamo por falta de recolección",
    explicacion: "Cuando el camión no pasó o no llevó la bolsa.",
    claves: ["reclamo_diagnostico", "reclamo_confirmacion", "reclamo_info_turnos"],
  },
  {
    rotulo: "Programas ambientales",
    explicacion: "SEPARÁ, EDUCÁ y TRANSFORMÁ.",
    claves: ["separa_info", "separa_fuera_de_avenidas", "educa_requisitos", "transforma_requisitos"],
  },
  {
    rotulo: "Cuando el vecino vota",
    explicacion:
      "Migue pregunta dos cosas distintas: después de una respuesta, si sirvió; y al terminar " +
      "un trámite, si resultó fácil. Son mediciones separadas porque los arreglos son opuestos " +
      "—una respuesta mala se corrige escribiendo, un trámite difícil se corrige cambiando los " +
      "pasos—. Vaciar cada pregunta apaga esa encuesta sin apagar la otra.",
    claves: [
      "seguimiento_tras_responder",
      "voto_gracias_util",
      "voto_pedir_detalle",
      "seguimiento_tras_tramite",
      "voto_tramite_detalle",
    ],
  },
  {
    rotulo: "Cuando no corresponde o no sabe",
    explicacion:
      "Los dos mensajes más delicados: son los que recibe alguien que ya escribió y no va a " +
      "obtener lo que pedía.",
    claves: ["fuera_de_alcance", "sin_respuesta"],
  },
  {
    rotulo: "Despedida",
    explicacion: "Cuando el vecino agradece y se va.",
    claves: ["despedida"],
  },
];

export default async function PaginaConocimiento() {
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

  // Lo que Migue no supo contestar. `v_sin_respuesta` (021) ya trae si la
  // respuesta vinculada está publicada: sin eso el panel no puede distinguir una
  // pregunta contestada de una con el borrador sin publicar, que para el vecino
  // sigue sin contestar.
  const { data: sinResponder, error: errorSin } = await supabase
    .from("v_sin_respuesta")
    .select("*")
    .order("veces_repetida", { ascending: false })
    .limit(300)
    .returns<PreguntaSinResponder[]>();

  // `opcional` se trae de la base y no se deduce de una lista acá: es lo que
  // decide si una frase puede vaciarse, y una lista local ya se había
  // desincronizado con la tabla.
  const { data: textos, error: errorTextos } = await supabase
    .from("textos_bot")
    .select("clave, texto, descripcion, opcional, actualizado_en")
    .order("clave")
    .returns<TextoBot[]>();

  // Cuántos mensajes de vecinos hay con los que comparar un disparador. Con
  // pocos, la prueba contra mensajes reales no concluye nada y conviene decirlo
  // en vez de mostrar un número que no significa lo que parece.
  const { count: mensajesEntrantes } = await supabase
    .from("mensajes")
    .select("id", { count: "exact", head: true })
    .eq("direccion", "entrante");

  // Sólo los valores de ejemplo para la vista previa. `marcadores_disponibles`
  // ya NO se lee: qué marcador vale en qué frase lo dice `marcadoresDe()` del
  // dominio, porque es una propiedad del código del bot —qué paso llama a
  // `interpolar` y con qué valores— y no un dato configurable. La clave de
  // configuración sigue en la base, pero nadie la usa: quedó como una lista
  // plana que afirmaba que los cuatro marcadores servían en cualquier mensaje.
  const { data: config } = await supabase
    .from("configuracion")
    .select("clave, valor")
    .in("clave", ["sla_horas_habiles", "empresa_recoleccion"]);

  const porClave = new Map((config ?? []).map((c) => [c.clave, c.valor]));

  const filasTexto = textos ?? [];
  const porClaveTexto = new Map(filasTexto.map((t) => [t.clave, t]));
  const enGrupos = GRUPOS.flatMap((g) => g.claves);

  const error = errorFaqs ?? errorFijas ?? errorSin ?? errorTextos;

  return (
    <Armazon persona={persona} actual="/conocimiento">
      <main>
        <div className="titulo-pagina">
          <h1>Conocimiento</h1>
        </div>
        <p className="bajada">
          Todo lo que Migue dice y ustedes pueden cambiar. Lo que se escribe acá pesa el doble que
          un fragmento de PDF cuando busca con qué responder, y el mejor lugar para empezar es la
          lista de lo que no supo.
        </p>

        {error && <div className="aviso mal">No pude leer todo: {error.message}</div>}

        <Respuestas
          faqs={faqs ?? []}
          fijas={fijas ?? []}
          sinResponder={sinResponder ?? []}
          puedePublicar={persona.rol === "admin" || persona.rol === "supervisor"}
          mensajesEntrantes={mensajesEntrantes ?? 0}
          gruposDeTexto={GRUPOS.map((g) => ({
            ...g,
            textos: g.claves
              .map((c) => porClaveTexto.get(c))
              .filter((t): t is TextoBot => t !== undefined),
            faltantes: g.claves.filter((c) => !porClaveTexto.has(c)),
          }))}
          textosSinAgrupar={filasTexto.filter((t) => !enGrupos.includes(t.clave))}
          ejemplos={{
            plazo: `${String(porClave.get("sla_horas_habiles") ?? 72)} hs hábiles`,
            empresa: String(porClave.get("empresa_recoleccion") ?? "").replace(/"/g, ""),
            vencimiento: "viernes 29/08 a las 16:00",
            direccion: "Lamadrid 550",
          }}
        />
      </main>
    </Armazon>
  );
}
