import { redirect } from "next/navigation";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { TablaDocumentos } from "./TablaDocumentos";
import type { Documento, PersonaNombre } from "@/lib/tipos";

/** Depende de la sesión: no hay nada que pre-renderizar. */
export const dynamic = "force-dynamic";

export default async function PaginaDocumentos() {
  const persona = await personaActual();
  if (!persona) redirect("/ingresar");

  const supabase = await clienteServidor();

  // Activos primero y después por título. El orden importa: lo que Migue puede
  // citar hoy va arriba, y lo dado de baja queda al final sin desaparecer.
  const { data: documentos, error } = await supabase
    .from("documentos")
    .select("*")
    .order("activo", { ascending: false })
    .order("titulo", { ascending: true })
    .returns<Documento[]>();

  // `subido_por` es un uuid sin foreign key, así que PostgREST no lo puede
  // embeber en la consulta de arriba. Se traen los nombres una vez y se mapea.
  // `.returns<T[]>()` no se lleva bien con una función que devuelve `setof`, así
  // que se afirma el tipo acá. El contrato lo fija `personal_nombres()` en la
  // migración 018: usuario_id, nombre y rol, sin el correo.
  const { data: personasCrudo } = await supabase.rpc("personal_nombres");
  const personas = (personasCrudo ?? []) as PersonaNombre[];

  // Si hay trabajos en vuelo, la tabla tiene que seguir refrescando. No alcanza
  // con mirar el estado de los documentos: un documento que se está BORRANDO
  // figura como «listo», así que sin esto su fila se quedaba en la lista hasta
  // que alguien recargaba a mano.
  const { count: trabajosEnVuelo } = await supabase
    .from("trabajos")
    .select("id", { count: "exact", head: true })
    .in("estado", ["pendiente", "tomado"]);

  const nombres = new Map(personas.map((p) => [p.usuario_id, p.nombre ?? "—"]));
  const filas = documentos ?? [];

  const activos = filas.filter((d) => d.activo).length;
  const fragmentos = filas
    .filter((d) => d.activo && d.estado === "listo")
    .reduce((suma, d) => suma + d.cantidad_fragmentos, 0);
  const conProblema = filas.filter((d) => d.estado === "error").length;

  return (
    <Armazon persona={persona} actual="/documentos">
      <main>
        <div className="titulo-pagina">
          <h1>Documentos</h1>
        </div>
        <p className="bajada">
          De acá sale lo que Migue responde cuando un vecino pregunta algo que no es un pedido
          ni un reclamo. Un documento dado de baja deja de citarse en el momento, sin esperar
          nada.
        </p>

        {error && (
          <div className="aviso mal">
            No pude leer los documentos: {error.message}
          </div>
        )}

        <div className="resumen">
          <div>
            <span className="n">{filas.length}</span>
            <span className="r">cargados</span>
          </div>
          <div>
            <span className="n">{activos}</span>
            <span className="r">que Migue cita</span>
          </div>
          <div>
            <span className="n">{fragmentos}</span>
            <span className="r">fragmentos buscables</span>
          </div>
          {conProblema > 0 && (
            <div>
              <span className="n" style={{ color: "var(--alerta)" }}>
                {conProblema}
              </span>
              <span className="r">con problema</span>
            </div>
          )}
        </div>

        <TablaDocumentos
          documentos={filas}
          nombres={Object.fromEntries(nombres)}
          bucket={process.env["NEXT_PUBLIC_SUPABASE_BUCKET_DOCUMENTOS"] ?? "documentos"}
          trabajosEnVuelo={trabajosEnVuelo ?? 0}
        />
      </main>
    </Armazon>
  );
}
