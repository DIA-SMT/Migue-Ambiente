/**
 * ¿Por qué Migue no interpreta bien un mensaje? Medido en el camino COMPLETO.
 *
 *   cd platform/packages/migue-dominio
 *   node --env-file=../../../.env.local herramientas/medir-camino-completo.mjs
 *
 * POR QUÉ EXISTE, Y POR QUÉ NO ALCANZABA `medir-clasificador.mjs`
 *
 * Ese script mide el clasificador solo, y da 28 de 29. Con ese número uno
 * concluye que el modelo entiende bien — y es cierto. Pero el vecino no habla
 * con el clasificador: habla con una cadena de tres etapas, y las tres pueden
 * mandar su mensaje a un lugar distinto.
 *
 *   1. REGLAS DE EXCLUSIÓN   corren PRIMERO, antes de cualquier modelo. Si una
 *                            palabra de la regla aparece en la frase, se deriva
 *                            y se CIERRA la conversación. El clasificador no se
 *                            entera.
 *   2. CLASIFICADOR          el modelo. Devuelve intención y confianza.
 *   3. `decidir()`           traduce eso en una ruta, y ahí el umbral y
 *                            `no_entendido` deciden si se busca en el corpus o
 *                            se impone el menú.
 *
 * Medir sólo la etapa 2 es medir la etapa que MENOS falla. Este script mide el
 * destino final, que es lo único que el vecino experimenta.
 *
 * Corre contra las reglas y la configuración REALES de producción: los mismos
 * umbrales, los mismos modelos, las mismas 7 exclusiones. No es un fixture.
 *
 * CUESTA PLATA: son llamadas reales al modelo, una por frase que llegue a la
 * etapa 2. Centavos.
 */
import { obtenerCatalogo } from "../src/datos/catalogo.ts";
import { evaluarExclusiones, corta } from "../src/reglas/exclusiones.ts";
import { clasificar, decidir } from "../src/ia/router.ts";

/**
 * Cada caso es [frase, a_dónde_debería_ir, nota].
 *
 * `deberia` usa el vocabulario del destino final, no de la intención:
 *   responder  = buscar en el corpus y contestar
 *   tramite    = arrancar un flujo
 *   derivar    = mandarlo a Migue, el asistente general
 *   menu       = mostrarle las opciones
 */
const CASOS = [
  // -------------------------------------------------------------------------
  // Preguntas de Ambiente que contienen una palabra de una regla de exclusión.
  // Son el caso que motivó este script.
  // -------------------------------------------------------------------------
  ["donde tiro las pilas", "responder", "pregunta de Ambiente; «pila» está en Residuos peligrosos"],
  ["las baterias de celular donde las llevo", "responder", "«bateria» está en la misma regla"],
  ["tengo que lavar los envases con agua antes de reciclarlos", "responder", "«agua» está en la regla del SAT"],
  ["quiero hacer una denuncia porque el vecino tira basura en la esquina", "tramite", "«denuncia» está en Infracciones; el prompt del router dice que es reclamo"],
  ["quiero denunciar que tiran basura en la esquina", "tramite", "la MISMA intención, forma verbal: no matchea la regla"],

  // -------------------------------------------------------------------------
  // La misma intención, corta y larga. Es la queja concreta: «con más texto
  // parece que no lo entiende».
  // -------------------------------------------------------------------------
  ["quiero pedir un retiro", "tramite", "corta"],
  ["hola, buenas tardes, mire, necesitaria saber como hago para que me retiren unos escombros que quedaron de una obra en mi casa", "tramite", "la misma, larga y con cortesía"],
  ["el camion no paso", "tramite", "corta"],
  ["buen dia, queria comentarles que en mi cuadra hace como cuatro dias que no pasa el camion recolector y ya se esta juntando mucha basura en la esquina", "tramite", "la misma, larga"],
  ["donde hay un punto verde", "responder", "corta"],
  ["disculpen la molestia, queria consultarles si hay algun punto verde cerca de barrio norte para llevar carton y botellas de plastico", "responder", "la misma, larga"],

  // -------------------------------------------------------------------------
  // Fuera de alcance de verdad: tiene que derivar.
  // -------------------------------------------------------------------------
  ["necesito una habilitacion comercial", "derivar", "no es de Ambiente"],
  ["se corto la luz en todo el barrio", "derivar", "falló en la medición anterior"],
  ["hay un bache enorme en mi calle", "derivar", "no es de Ambiente"],
  ["quiero pagar el impuesto inmobiliario", "derivar", "no es de Ambiente"],

  // -------------------------------------------------------------------------
  // Basura de verdad: el menú está bien acá.
  // -------------------------------------------------------------------------
  ["asdfgh", "menu", "sin sentido"],
  ["ok", "menu", "sin contenido"],

  // -------------------------------------------------------------------------
  // Consultas con errores de tipeo. Hoy el respaldo difuso busca SÓLO en FAQs,
  // y hay 0 FAQs, así que no tienen red.
  // -------------------------------------------------------------------------
  ["cuando pasa el camoin de la basura", "responder", "tipeo"],
  ["se puede recicalr el telgopor", "responder", "tipeo"],
];

const DESTINO = {
  consultar_conocimiento: "responder",
  iniciar_flujo: "tramite",
  derivar: "derivar",
  mostrar_menu: "menu",
  saludar: "saludo",
  despedir: "despedida",
};

const catalogo = await obtenerCatalogo();

console.log(
  `\nCamino completo, con las reglas y umbrales REALES de producción.\n` +
    `${catalogo.reglasExclusion.length} reglas de exclusión activas.\n`,
);

let costo = 0;
const fallas = [];
const porEtapa = { exclusion: 0, clasificador: 0, decision: 0 };

for (const [frase, deberia, nota] of CASOS) {
  let destino;
  let etapa;
  let detalle;

  // ETAPA 1 · Las exclusiones, antes de cualquier modelo.
  const coincidencia = evaluarExclusiones(frase, catalogo.reglasExclusion);
  if (coincidencia !== null && corta(coincidencia)) {
    destino = "derivar";
    etapa = "exclusion";
    detalle = `regla «${coincidencia.regla.nombre}»`;
  } else {
    // ETAPA 2 · El modelo.
    const c = await clasificar(frase, catalogo);
    costo += c.costoUsd ?? 0;

    // ETAPA 3 · La traducción a una ruta.
    const d = decidir(c, catalogo);
    destino = DESTINO[d.tipo] ?? d.tipo;
    etapa = d.tipo === "mostrar_menu" && c.intencion !== "no_entendido" ? "decision" : "clasificador";
    detalle = `${c.intencion} conf ${c.confianza}${c.porAtajo ? " (atajo)" : ""}`;
  }

  const bien = destino === deberia;
  if (!bien) {
    fallas.push({ frase, deberia, destino, etapa, detalle, nota });
    porEtapa[etapa]++;
  }

  const marca = bien ? "ok  " : "MAL ";
  const corte = frase.length > 52 ? frase.slice(0, 49) + "..." : frase;
  console.log(
    `  ${marca} ${corte.padEnd(53)}${destino.padEnd(11)}${bien ? "" : "(esperaba " + deberia + ")  "}${detalle}`,
  );
}

console.log(`\n  ${CASOS.length - fallas.length} de ${CASOS.length} llegan a donde corresponde`);
console.log(`  costo de la medición: US$ ${costo.toFixed(6)}`);

if (fallas.length > 0) {
  console.log(`\n  DÓNDE SE PIERDE CADA UNA:`);
  // Agrupado por etapa, porque la conclusión que importa es en qué CAPA está el
  // problema. Si todas las fallas fueran de la etapa 2, cambiar el modelo o el
  // prompt tendría sentido; si están en la 1 o la 3, cambiar el modelo no
  // arregla nada.
  for (const etapa of ["exclusion", "clasificador", "decision"]) {
    const suyas = fallas.filter((f) => f.etapa === etapa);
    if (suyas.length === 0) continue;
    const nombre = {
      exclusion: "ETAPA 1 · las reglas de exclusión, ANTES del modelo",
      clasificador: "ETAPA 2 · el modelo",
      decision: "ETAPA 3 · la traducción a una ruta",
    }[etapa];
    console.log(`\n  ${nombre} — ${suyas.length} falla(s)`);
    for (const f of suyas) {
      console.log(`    «${f.frase}»`);
      console.log(`       fue a ${f.destino}, esperaba ${f.deberia} · ${f.detalle}`);
      console.log(`       ${f.nota}`);
    }
  }

  console.log(
    `\n  REPARTO: etapa 1 = ${porEtapa.exclusion} · etapa 2 = ${porEtapa.clasificador} · ` +
      `etapa 3 = ${porEtapa.decision}`,
  );
  console.log(
    `  Cambiar el modelo o el prompt sólo puede mejorar las de la etapa 2.\n`,
  );
} else {
  console.log(`\n  todas llegan a donde corresponde\n`);
}

process.exit(fallas.length === 0 ? 0 : 1);
