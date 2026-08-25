import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Reglas } from "./Reglas";
import type {
  FilaConfiguracion,
  FilaExclusion,
  FilaLimite,
  FilaPuntoVerde,
  FilaZona,
} from "@/lib/tipos";

export const dynamic = "force-dynamic";

/**
 * Las reglas que gobiernan al bot.
 *
 * Es la pantalla de mayor consecuencia del panel: un valor mal puesto acá no da
 * un error de base, cambia lo que el municipio le promete a un vecino. Por eso
 * cada control dice qué pasa si se toca, y los que NO hacen nada están marcados
 * como tales en lugar de escondidos.
 */
export default async function PaginaReglas() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  const [config, limites, exclusiones, puntos, zonas] = await Promise.all([
    supabase.from("configuracion").select("*").order("clave").returns<FilaConfiguracion[]>(),
    supabase.from("limites_volumen").select("*").order("categoria").returns<FilaLimite[]>(),
    supabase.from("reglas_exclusion").select("*").order("prioridad").returns<FilaExclusion[]>(),
    supabase.from("puntos_verdes").select("*").order("orden").returns<FilaPuntoVerde[]>(),
    supabase.from("zonas_recoleccion").select("*").order("nombre").returns<FilaZona[]>(),
  ]);

  const error =
    config.error ?? limites.error ?? exclusiones.error ?? puntos.error ?? zonas.error;

  // ¿Los valores de estas tablas están TAMBIÉN escritos adentro de los
  // documentos indexados? Si lo están, una consulta libre se contesta con el
  // texto del PDF y no con la tabla, así que cambiar el número acá no cambia lo
  // que Migue responde. Se comprueba en cada carga en vez de dejarlo escrito:
  // en cuanto se corrija el documento, el aviso desaparece solo.
  //
  // Verificado de punta a punta: el 24/08 un vecino preguntó cuáles son los
  // Puntos Verdes y Migue contestó las tres direcciones con
  // `origen_respuesta = 'documentos'`, citando 8 fragmentos. No salió de
  // `puntos_verdes`.
  const agujas = [
    ...(puntos.data ?? []).slice(0, 4).map((p) => p.direccion),
    "LIMITE_ESCOMBROS",
    "ZONA_NORTE",
  ].filter(Boolean);

  const documentosConLosMismosDatos = new Set<string>();
  for (const aguja of agujas) {
    const { data } = await supabase
      .from("fragmentos")
      .select("documento_id")
      .ilike("texto", `%${aguja}%`)
      .limit(5);
    for (const f of data ?? []) documentosConLosMismosDatos.add(f.documento_id as string);
  }

  let titulosDuplicados: string[] = [];
  if (documentosConLosMismosDatos.size > 0) {
    const { data } = await supabase
      .from("documentos")
      .select("titulo")
      .in("id", [...documentosConLosMismosDatos]);
    titulosDuplicados = (data ?? []).map((d) => d.titulo as string);
  }

  return (
    <Armazon persona={persona} actual="/reglas">
      <main>
        <div className="titulo-pagina">
          <h1>Reglas</h1>
        </div>
        <p className="bajada">
          Cómo decide Migue: los plazos que promete, cuándo se anima a responder, cuánto se puede
          sacar y qué no es de Ambiente. Es la pantalla de mayor consecuencia del panel — lo que se
          cambia acá cambia lo que el municipio le dice a un vecino.
        </p>

        {error && <div className="aviso mal">No pude leer las reglas: {error.message}</div>}

        <Reglas
          configuracion={config.data ?? []}
          limites={limites.data ?? []}
          exclusiones={exclusiones.data ?? []}
          puntos={puntos.data ?? []}
          zonas={zonas.data ?? []}
          documentosDuplicados={titulosDuplicados}
        />
      </main>
    </Armazon>
  );
}
