/**
 * Prueba `buscar_conocimiento` contra los fragmentos ya indexados.
 *
 *   node --env-file=../../../../.env.local herramientas/probar-busqueda.mjs
 *   node --env-file=../../../../.env.local herramientas/probar-busqueda.mjs "mi pregunta"
 *
 * No usa el modelo: muestra qué material encontraría Migue, que es lo que
 * decide si puede responder o si tiene que admitir que no sabe.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const CONSULTAS = process.argv[2]
  ? [process.argv[2]]
  : [
      "en qué turnos pasa el camión de basura",
      "cuántos contenedores hay en la ciudad",
      "qué es el programa SEPARÁ",
      "cómo separo los residuos en casa",
      "qué hago con los neumáticos viejos",
      "quiero un taller para mi escuela",
      "dónde están los puntos verdes",
      "cuánto tarda el retiro de escombros",
      "cuál es el límite de volumen para el retiro",
      // Un control negativo: si esto devuelve algo con rank alto, el buscador
      // está trayendo ruido.
      "cómo renuevo el registro de conducir",
    ];

for (const consulta of CONSULTAS) {
  const { data, error } = await supabase.rpc("buscar_conocimiento", {
    p_consulta: consulta,
    p_limite: 3,
  });

  if (error) {
    console.log(`\n«${consulta}»\n   ERROR: ${error.message}`);
    continue;
  }

  console.log(`\n«${consulta}»`);
  if (!data || data.length === 0) {
    console.log("   (sin resultados — Migue diría que no sabe)");
    continue;
  }
  for (const r of data) {
    const cita = r.pagina ? `p.${r.pagina}` : "—";
    console.log(
      `   [${r.rank.toFixed(3)}]${r.difuso ? " ~" : "  "} ${r.origen.padEnd(9)} ${cita.padStart(5)}  ${(r.titulo ?? "").slice(0, 40).padEnd(40)} ${(r.documento_titulo ?? "").slice(0, 26)}`,
    );
    console.log(`            ${r.texto.replace(/\n/g, " ").slice(0, 110)}`);
  }
}
