import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { EditorTextos } from "./EditorTextos";

export const dynamic = "force-dynamic";

export interface TextoBot {
  clave: string;
  texto: string;
  descripcion: string | null;
  actualizado_en: string;
}

/**
 * Los mensajes que el bot le manda al vecino.
 *
 * Es la pantalla más directa del panel: lo que se escribe acá es literalmente lo
 * que va a leer una persona en su teléfono. Sin modelo en el medio, sin
 * interpretación.
 *
 * Se agrupan por flujo y no alfabéticamente: quien viene a corregir el mensaje
 * de confirmación de un retiro quiere ver los otros mensajes de ese mismo flujo
 * al lado, para que el tono no quede desparejo.
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
    claves: ["reclamo_diagnostico", "reclamo_confirmacion"],
  },
  {
    rotulo: "Programas ambientales",
    explicacion: "SEPARÁ, EDUCÁ y TRANSFORMÁ.",
    claves: ["separa_info", "separa_fuera_de_avenidas", "educa_requisitos", "transforma_requisitos"],
  },
  {
    rotulo: "Cuando no corresponde o no sabe",
    explicacion:
      "Los dos mensajes más delicados: son los que recibe alguien que ya escribió y no va a " +
      "obtener lo que pedía.",
    claves: ["fuera_de_alcance", "sin_respuesta"],
  },
];

export default async function PaginaTextos() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  const { data: textos, error } = await supabase
    .from("textos_bot")
    .select("clave, texto, descripcion, actualizado_en")
    .order("clave")
    .returns<TextoBot[]>();

  // Los marcadores que el bot sabe reemplazar. Vienen de la base y no de una
  // constante: `marcadores_disponibles` es la lista que mantiene el proyecto, y
  // duplicarla acá haría que el panel ofrezca marcadores que el bot no resuelve.
  const { data: config } = await supabase
    .from("configuracion")
    .select("clave, valor")
    .in("clave", ["marcadores_disponibles", "sla_horas_habiles", "empresa_recoleccion"]);

  const porClave = new Map((config ?? []).map((c) => [c.clave, c.valor]));
  const marcadores = String(porClave.get("marcadores_disponibles") ?? "")
    .replace(/"/g, "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.startsWith("{"));

  const filas = textos ?? [];
  const porClaveTexto = new Map(filas.map((t) => [t.clave, t]));

  // Claves que el código lee y no tienen fila. Sin esto, un mensaje que el bot
  // busca y no encuentra es invisible desde el panel.
  const enGrupos = GRUPOS.flatMap((g) => g.claves);
  const sinAgrupar = filas.filter((t) => !enGrupos.includes(t.clave)).map((t) => t.clave);

  return (
    <Armazon persona={persona} actual="/textos">
      <main>
        <div className="titulo-pagina">
          <h1>Textos del bot</h1>
        </div>
        <p className="bajada">
          Lo que se escribe acá es exactamente lo que lee un vecino en su teléfono. No pasa por el
          modelo: se envía tal cual.
        </p>

        {error && <div className="aviso mal">No pude leer los textos: {error.message}</div>}

        <EditorTextos
          grupos={GRUPOS.map((g) => ({
            ...g,
            textos: g.claves
              .map((c) => porClaveTexto.get(c))
              .filter((t): t is TextoBot => t !== undefined),
            faltantes: g.claves.filter((c) => !porClaveTexto.has(c)),
          }))}
          sinAgrupar={sinAgrupar
            .map((c) => porClaveTexto.get(c))
            .filter((t): t is TextoBot => t !== undefined)}
          marcadores={marcadores}
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
