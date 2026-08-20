/**
 * Integración de la cadena de conocimiento, de punta a punta.
 *
 * Siembra una FAQ y un documento con fragmentos, hace preguntas reales contra
 * OpenRouter y borra todo al terminar. Es la única prueba que ejercita la
 * cadena completa: búsqueda en la base, expansión de consulta y síntesis.
 *
 * Cuesta unas pocas llamadas a OpenRouter (del orden de 0,002 USD por corrida).
 * Se saltea sola si falta alguna credencial.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { obtenerCliente } from "../datos/cliente.ts";
import { invalidarCatalogo, obtenerCatalogo } from "../datos/catalogo.ts";
import { buscarEnConocimiento, esMaterialSuficiente } from "./buscar.ts";
import { responderConsulta } from "./responder.ts";

const hayCredenciales =
  Boolean(process.env["SUPABASE_URL"]) &&
  Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]) &&
  Boolean(process.env["OPENROUTER_API_KEY"]);

const RUTA_DOC = "docs/__prueba_conocimiento__.pdf";
const MARCA_FAQ = "__prueba conocimiento__";

/**
 * Material sembrado.
 *
 * El contenido sale de los PDFs institucionales reales (Programa CONTROLÁ y
 * SEPARÁ), así que las preguntas de prueba son las que un vecino haría de
 * verdad.
 */
const FRAGMENTOS = [
  {
    orden: 1,
    titulo_seccion: "Recolección domiciliaria",
    pagina: 12,
    texto:
      "El control y monitoreo de camiones compactadores se realiza por medio del sistema de GPS. " +
      "Los servicios son 46 en total: del 1 al 20 se realizan en el turno mañana de 06 a 14 hs de " +
      "lunes a sábado; del 21 al 43 en el turno noche de 21 a 04 hs.",
  },
  {
    orden: 2,
    titulo_seccion: "Barrido mecánico",
    pagina: 14,
    texto:
      "El barrido mecánico se divide en dos recorridos: uno durante el turno mañana de 06 a 13 hs " +
      "de lunes a sábados y otro en el turno noche de 22 a 04 hs, excepto cuando las condiciones " +
      "climáticas no lo permitan.",
  },
];

describe(
  "cadena de conocimiento contra Supabase y OpenRouter reales",
  { skip: !hayCredenciales ? "faltan credenciales" : false },
  () => {
    before(async () => {
      await limpiar();

      const db = obtenerCliente();
      const { data: doc, error } = await db
        .from("documentos")
        .insert({
          titulo: "Programa CONTROLÁ (prueba)",
          nombre_archivo: "controla-prueba.pdf",
          formato: "pdf",
          ruta_storage: RUTA_DOC,
          bytes: 1000,
          estado: "listo",
        })
        .select("id")
        .single();
      assert.equal(error, null, `no pude sembrar el documento: ${error?.message}`);

      await db
        .from("fragmentos")
        .insert(FRAGMENTOS.map((f) => ({ ...f, documento_id: doc!.id })));

      await db.from("faqs").insert({
        pregunta: `¿En qué turnos pasa el camión de basura? ${MARCA_FAQ}`,
        respuesta:
          "Hay tres turnos: mañana de 06 a 14 hs, tarde de 14 a 20 hs y noche de 21 a 04 hs. " +
          "El turno de tu cuadra depende del servicio asignado.",
        etiquetas: ["recoleccion", "turnos"],
      });

      invalidarCatalogo();
    });

    after(async () => {
      await limpiar();
      invalidarCatalogo();
    });

    it("encuentra material en las dos fuentes", async () => {
      const r = await buscarEnConocimiento("turnos recoleccion camiones compactadores");
      assert.ok(r.length > 0, "no encontró nada");
      assert.equal(esMaterialSuficiente(r), true);
      assert.ok(
        r.some((c) => c.origen === "fragmento"),
        "no encontró el fragmento del documento",
      );
    });

    it("la FAQ rankea por encima del fragmento", async () => {
      // Una respuesta escrita por alguien del área le gana a un pedazo de PDF:
      // ya está redactada para un vecino y alguien la revisó.
      const r = await buscarEnConocimiento("en que turnos pasa el camion de basura");
      assert.equal(r[0]?.origen, "faq", `ganó un ${r[0]?.origen}`);
    });

    it("los fragmentos traen la referencia para poder citar", async () => {
      const r = await buscarEnConocimiento("barrido mecanico recorridos");
      const frag = r.find((c) => c.origen === "fragmento");
      assert.ok(frag, "no encontró el fragmento");
      assert.equal(frag!.documentoTitulo, "Programa CONTROLÁ (prueba)");
      assert.equal(frag!.pagina, 14);
    });

  it("con algunas palabras bien escritas resuelve por OR, no por similitud", async () => {
      // Los tres niveles de búsqueda hacen que un tipeo parcial NO caiga al
      // respaldo difuso: «turnos» y «pasa» están bien escritas, así que el
      // nivel OR encuentra coincidencias reales de texto completo.
      //
      // Importa la distinción: una coincidencia real alcanza para responder, un
      // parecido ortográfico no.
      const r = await buscarEnConocimiento("en ke turnos pasa el camoin de basra");
      assert.ok(r.length > 0, "el nivel OR no encontró nada");
      assert.equal(r.some((c) => !c.difuso), true, "debería haber coincidencias reales");
      assert.equal(esMaterialSuficiente(r), true, "y alcanzan para responder");
    });

    it("con todo mal escrito cae al respaldo por similitud", async () => {
      const r = await buscarEnConocimiento("turnso del camoin de basra");
      assert.ok(r.length > 0, "el respaldo difuso no encontró nada");
      assert.equal(r.every((c) => c.difuso), true, "debería venir todo del respaldo");
      // Y por eso mismo no alcanza para responder: es un parecido ortográfico,
      // no una coincidencia de contenido. Con eso conviene registrar la
      // pregunta antes que arriesgar un dato municipal equivocado.
      assert.equal(esMaterialSuficiente(r), false);
    });

    it("una consulta sin relación no encuentra nada", async () => {
      const r = await buscarEnConocimiento("tramites de licencia de conducir");
      assert.equal(esMaterialSuficiente(r), false);
    });

    it("responde una consulta real usando SÓLO el material sembrado", async () => {
      const catalogo = await obtenerCatalogo();
      const r = await responderConsulta("en que turnos pasa el camion de basura?", catalogo);

      assert.equal(r.tipo, "sintetizada", `tipo ${r.tipo}: ${r.texto}`);
      if (r.tipo !== "sintetizada") return;

      // El dato tiene que salir del material, no del conocimiento general.
      assert.match(r.texto, /06|14|21|mañana|noche/i, `respuesta sin datos del material: ${r.texto}`);
      assert.ok(r.traza.modelo, "no registró el modelo");
      assert.ok(r.traza.tokensEntrada > 0 && r.traza.tokensSalida > 0);
      assert.ok(r.traza.latenciaMs > 0);

      // Texto plano: el formato lo decide el adaptador de canal, no el modelo.
      assert.doesNotMatch(r.texto, /\*\*|^#{1,6}\s/m, `devolvió markdown: ${r.texto}`);
    });

    it("expande la consulta antes de buscar", async () => {
      const catalogo = await obtenerCatalogo();
      const r = await responderConsulta("a que hora levantan la basura", catalogo);
      assert.ok(
        r.traza.consultaExpandida,
        "no registró la expansión, y es lo que hace viable buscar sin vectores",
      );
    });

    it("REGRESIÓN · admite que no sabe en vez de inventar", async () => {
      // Es la regla que gobierna el módulo. Un horario inventado hace que el
      // vecino organice su semana con un dato falso.
      const catalogo = await obtenerCatalogo();
      const r = await responderConsulta(
        "cuanto cuesta renovar la licencia de conducir clase B",
        catalogo,
      );
      assert.equal(r.tipo, "sin_respuesta", `contestó algo: ${r.texto}`);
      assert.match(r.texto, /no tengo esa información/i);
    });

    it("una respuesta fija corta la cadena sin llamar al modelo", async () => {
      const db = obtenerCliente();
      const { data } = await db
        .from("respuestas_fijas")
        .insert({
          nombre: `Prueba conocimiento ${MARCA_FAQ}`,
          disparadores: ["licencia de conducir"],
          modo: "contiene",
          respuesta: "Las licencias de conducir no se gestionan por este canal.",
          prioridad: 5,
        })
        .select("id")
        .single();
      invalidarCatalogo();

      try {
        const catalogo = await obtenerCatalogo();
        const r = await responderConsulta("necesito una licencia de conducir", catalogo);
        assert.equal(r.tipo, "fija");
        if (r.tipo !== "fija") return;
        assert.equal(r.texto, "Las licencias de conducir no se gestionan por este canal.");
        assert.equal(r.traza.modelo, null, "no debería haber llamado a ningún modelo");
        assert.equal(r.traza.tokensSalida, 0);
      } finally {
        await db.from("respuestas_fijas").delete().eq("id", data!.id);
        invalidarCatalogo();
      }
    });
  },
);

async function limpiar(): Promise<void> {
  const db = obtenerCliente();
  // Los fragmentos caen por cascada al borrar el documento.
  await db.from("documentos").delete().eq("ruta_storage", RUTA_DOC);
  await db.from("faqs").delete().ilike("pregunta", `%${MARCA_FAQ}%`);
  await db.from("respuestas_fijas").delete().ilike("nombre", `%${MARCA_FAQ}%`);
  await db.from("sin_respuesta").delete().ilike("pregunta", "%licencia de conducir%");
}
