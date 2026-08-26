import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Portada, type Pendiente } from "./Portada";
import { LIMITE_FILAS, medirCasos } from "@/lib/metricas";
import type { Ticket } from "@/lib/tipos";

export const dynamic = "force-dynamic";

/** «3 casos vencidos», pero «1 caso vencido». */
function plural(n: number, uno: string, muchos: string): string {
  return n === 1 ? uno : muchos;
}

/**
 * La portada del panel.
 *
 * Los dos números que muestra se calculan con las mismas funciones que usa la
 * pantalla de Métricas —`medirCasos`, que se apoya en `estaCerrado` y
 * `situacionSla`— y no con un `count` filtrado en SQL. Es deliberado: esta base
 * ya tuvo dos números contradictorios sobre las mismas filas porque «cerrado»
 * estaba definido dos veces. La portada y Métricas tienen que decir lo mismo o
 * es peor que no decir nada.
 *
 * Las preguntas sin responder sí se cuentan en la base, porque ahí «pendiente»
 * es una columna y no una regla: no hay lógica que duplicar.
 */
export default async function Inicio() {
  const persona = await personaActual();

  // El middleware ya mandó al login a quien no tiene sesión. Si llegó acá sin
  // persona, es que su cuenta existe pero no está en el padrón.
  if (!persona) {
    return (
      <div className="pantalla-ingreso">
        <div className="caja-ingreso">
          <h1>Cuenta sin habilitar</h1>
          <p>
            Tu cuenta existe pero todavía no está habilitada para usar el panel. Pedile a un
            administrador que te agregue.
          </p>
        </div>
      </div>
    );
  }

  const supabase = await clienteServidor();

  const [tickets, sinResponder] = await Promise.all([
    supabase.from("tickets").select("*").limit(LIMITE_FILAS).returns<Ticket[]>(),

    // `head: true` no trae filas, sólo el total. Los agregados de PostgREST
    // están deshabilitados en este proyecto, pero el count exacto con filtro
    // funciona — es el mismo patrón que usa la pantalla de Conocimiento.
    supabase
      .from("v_sin_respuesta")
      .select("id", { count: "exact", head: true })
      .eq("estado", "pendiente"),
  ]);

  const casos = medirCasos(tickets.data ?? [], Date.now());
  const preguntas = sinResponder.count ?? 0;

  // Sólo entra lo que tiene algo esperando. Una tarjeta que dice «0 casos
  // vencidos» es una buena noticia la primera vez y ruido todas las demás; y
  // una portada llena de ceros enseña a no mirarla.
  const pendientes: Pendiente[] = [];

  if (casos.vencidos > 0) {
    pendientes.push({
      cuanto: casos.vencidos,
      que: plural(casos.vencidos, "caso vencido", "casos vencidos"),
      porQue: "El plazo que Migue le prometió al vecino ya pasó.",
      adonde: "/casos",
      urgente: true,
    });
  }

  if (preguntas > 0) {
    pendientes.push({
      cuanto: preguntas,
      que: plural(preguntas, "pregunta sin responder", "preguntas sin responder"),
      porQue: "Migue no supo qué contestar. Escribir la respuesta las cierra.",
      adonde: "/conocimiento",
      urgente: false,
    });
  }

  if (casos.abiertos > 0) {
    pendientes.push({
      cuanto: casos.abiertos,
      que: plural(casos.abiertos, "caso abierto", "casos abiertos"),
      porQue: "Pedidos y reclamos que todavía no se resolvieron.",
      adonde: "/casos",
      urgente: false,
    });
  }

  return (
    <Armazon persona={persona} actual="/">
      <Portada
        persona={persona}
        pendientes={pendientes}
        problema={tickets.error?.message ?? sinResponder.error?.message ?? null}
        ahora={new Date()}
      />
    </Armazon>
  );
}
