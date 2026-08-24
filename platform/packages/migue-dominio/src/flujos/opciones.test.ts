import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { numeroDeOpcion, OPCIONES_MENU, resolverOpcion } from "./opciones.ts";
import { NOMBRES_FLUJO } from "./tipos.ts";

/** Las tres categorías de residuo, que es el caso real más usado. */
const CATEGORIAS = [
  { id: "escombros", etiqueta: "Escombros / material de construcción" },
  { id: "poda", etiqueta: "Restos de poda / ramas" },
  { id: "voluminosos", etiqueta: "Muebles, electrodomésticos, chatarra" },
];

describe("numeroDeOpcion", () => {
  it("toma el número solo, que es lo que la gente escribe", () => {
    // El caso reportado: el vecino lee el menú y contesta «1».
    assert.equal(numeroDeOpcion("1", 4), 1);
    assert.equal(numeroDeOpcion("3", 4), 3);
    assert.equal(numeroDeOpcion(" 2 ", 4), 2);
  });

  it("tolera la puntuación de lista", () => {
    // Mucha gente copia el formato del menú.
    for (const t of ["2.", "2)", "- 2", "• 2", "*2"]) {
      assert.equal(numeroDeOpcion(t, 4), 2, `falló con «${t}»`);
    }
  });

  it("entiende «opción 2» y «la 3»", () => {
    assert.equal(numeroDeOpcion("opcion 2", 4), 2);
    assert.equal(numeroDeOpcion("opción 2", 4), 2);
    assert.equal(numeroDeOpcion("la 3", 4), 3);
    assert.equal(numeroDeOpcion("el 1", 4), 1);
    assert.equal(numeroDeOpcion("numero 4", 4), 4);
  });

  it("NO confunde una cantidad con una opción", () => {
    // Éste es el caso que puede arruinar un pedido: en un paso con tres
    // opciones, «3 bolsas» no elige la tercera. El vecino está diciendo cuánto.
    assert.equal(numeroDeOpcion("3 bolsas", 3), null);
    assert.equal(numeroDeOpcion("2 metros cubicos", 3), null);
    assert.equal(numeroDeOpcion("son 4 ramas grandes", 4), null);
    assert.equal(numeroDeOpcion("entre 2 y 3 metros", 4), null);
  });

  it("NO confunde una dirección con una opción", () => {
    assert.equal(numeroDeOpcion("Lamadrid 250", 4), null);
    assert.equal(numeroDeOpcion("Muñecas 200", 4), null);
  });

  it("rechaza un número fuera de rango", () => {
    // Con cuatro opciones, un «7» es un error de tipeo o algo que no entendimos.
    // Tomarlo como la última opción sería inventar.
    assert.equal(numeroDeOpcion("7", 4), null);
    assert.equal(numeroDeOpcion("0", 4), null);
    assert.equal(numeroDeOpcion("25", 4), null);
  });

  it("un texto vacío o sin números no es una opción", () => {
    assert.equal(numeroDeOpcion("", 4), null);
    assert.equal(numeroDeOpcion("hola", 4), null);
  });
});

describe("resolverOpcion", () => {
  it("resuelve por número", () => {
    assert.equal(resolverOpcion("2", CATEGORIAS), "poda");
    assert.equal(resolverOpcion("opcion 3", CATEGORIAS), "voluminosos");
  });

  it("resuelve por el id, que es lo que manda un botón", () => {
    assert.equal(resolverOpcion("escombros", CATEGORIAS), "escombros");
  });

  it("NO resuelve por una palabra suelta de la etiqueta, y es deliberado", () => {
    // Tentador y equivocado. Dos razones, las dos aprendidas rompiendo tests:
    //
    // 1) Los pasos leen la elección con `textoEfectivo()`, que devuelve
    //    `seleccion ?? texto`. Si «escombros, 3 bolsas» resolviera la categoría
    //    por la palabra, `seleccion` reemplazaría al texto y se perdería el
    //    «3 bolsas»: el vecino tendría que repetir la cantidad.
    //
    // 2) Buscar palabras sueltas es hacer de clasificador, y peor que el que ya
    //    hay. Para eso está `detectarCategoria`, que sí mira el texto completo.
    assert.equal(resolverOpcion("tengo escombros de una obra", CATEGORIAS), null);
    assert.equal(resolverOpcion("ramas", CATEGORIAS), null);
  });

  it("copiar y pegar la etiqueta completa funciona", () => {
    assert.equal(resolverOpcion("Restos de poda / ramas", CATEGORIAS), "poda");
  });

  it("no le importan los acentos ni las mayúsculas", () => {
    // Sobre el id y la etiqueta completos, que es lo que sí resuelve.
    assert.equal(resolverOpcion("ESCOMBROS", CATEGORIAS), "escombros");
    assert.equal(resolverOpcion("  Poda  ", CATEGORIAS), "poda");
    assert.equal(resolverOpcion("RESTOS DE PODA / RAMAS", CATEGORIAS), "poda");
    assert.equal(resolverOpcion("Escombros / material de construcción", CATEGORIAS), "escombros");
  });

  it("ante dos candidatos NO adivina", () => {
    // Elegir mal es peor que repreguntar: un vecino al que le tomaron la opción
    // equivocada termina con un pedido de otra cosa.
    const ambiguas = [
      { id: "a", etiqueta: "Poda de árboles grandes" },
      { id: "b", etiqueta: "Poda de arbustos" },
    ];
    assert.equal(resolverOpcion("poda", ambiguas), null);
  });

  it("ignora las palabras cortas de las etiquetas", () => {
    // Sin el mínimo de cuatro letras, «de» coincidiría con casi todo.
    assert.equal(resolverOpcion("de", CATEGORIAS), null);
    assert.equal(resolverOpcion("la", CATEGORIAS), null);
  });

  it("un texto que no tiene nada que ver devuelve null", () => {
    assert.equal(resolverOpcion("cuando pasa el camion", CATEGORIAS), null);
    assert.equal(resolverOpcion("hola buenas tardes", CATEGORIAS), null);
  });

  it("sin opciones o sin texto, null", () => {
    assert.equal(resolverOpcion("1", []), null);
    assert.equal(resolverOpcion(null, CATEGORIAS), null);
    assert.equal(resolverOpcion("", CATEGORIAS), null);
  });
});

describe("OPCIONES_MENU", () => {
  it("cada número del menú resuelve a la opción de esa posición", () => {
    // Es el caso que se reportó al probar el bot: leer el menú y contestar el
    // número, y que no pasara nada.
    assert.equal(resolverOpcion("1", OPCIONES_MENU), "retiro_no_habitual");
    assert.equal(resolverOpcion("2", OPCIONES_MENU), "reclamo_recoleccion");
    assert.equal(resolverOpcion("3", OPCIONES_MENU), "programa_separa");
    assert.equal(resolverOpcion("6", OPCIONES_MENU), "consulta_libre");
    // Un número más allá del final no elige nada, en vez de caer en la última.
    assert.equal(resolverOpcion("7", OPCIONES_MENU), null);
  });

  it("cada id es un flujo REAL o consulta_libre", () => {
    // Este test estaba mal escrito y no probaba nada: comparaba los ids contra
    // una lista puesta a mano acá mismo, así que confirmaba mi suposición en vez
    // de la realidad. Pasaba con una opción «programas» que no era ningún flujo,
    // y elegirla hacía que `iniciarFlujo` recibiera undefined y el bot se cayera.
    //
    // Ahora se compara contra NOMBRES_FLUJO, que es de donde el orquestador saca
    // los flujos.
    const validos: readonly string[] = [...NOMBRES_FLUJO, "consulta_libre"];
    for (const o of OPCIONES_MENU) {
      assert.ok(validos.includes(o.id), `«${o.id}» no es un flujo ni consulta_libre`);
    }
  });

  it("no repite ids ni deja etiquetas vacías", () => {
    const ids = OPCIONES_MENU.map((o) => o.id);
    assert.equal(new Set(ids).size, ids.length, "hay ids repetidos");
    for (const o of OPCIONES_MENU) {
      assert.ok(o.etiqueta.trim().length > 3, `«${o.id}» tiene una etiqueta muy corta`);
    }
  });

  it("una PREGUNTA sobre el camión no arranca el flujo de reclamo", () => {
    // La razón de fondo para no buscar palabras sueltas. «camión» está en la
    // etiqueta de la opción 2, así que una coincidencia por palabra habría
    // metido a quien PREGUNTA en el flujo de RECLAMO.
    //
    // El prompt del clasificador tiene esta regla escrita: «¿Cuándo pasa el
    // camión?» es una consulta; «el camión no pasó» es un reclamo. Distinguirlas
    // necesita entender la frase, no encontrar una palabra.
    assert.equal(resolverOpcion("cuando pasa el camion?", OPCIONES_MENU), null);
    assert.equal(resolverOpcion("el camion no paso por mi casa", OPCIONES_MENU), null);
  });

  it("el NÚMERO de una cantidad no elige del menú", () => {
    // El menú tiene cuatro opciones, así que un «3» suelto elegiría la tercera.
    // Con «3 bolsas» eso no debe pasar: el 3 es una cantidad, y tomarlo como
    // opción arrancaría el flujo de programas ambientales.
    assert.equal(resolverOpcion("3 bolsas de escombros", OPCIONES_MENU), null);
    assert.equal(numeroDeOpcion("3 bolsas de escombros", OPCIONES_MENU.length), null);
  });

  it("elegir del menú ahorra la llamada al modelo; describir el problema no", () => {
    // Elegir es explícito y no hace falta adivinar nada: el número resuelve y el
    // clasificador no se llama. Describir el problema con palabras SÍ va al
    // clasificador, que es quien sabe leer una frase.
    assert.equal(resolverOpcion("2", OPCIONES_MENU), "reclamo_recoleccion");
    assert.equal(resolverOpcion("El camión no pasó", OPCIONES_MENU), "reclamo_recoleccion");
    assert.equal(resolverOpcion("hace tres dias que no pasan a llevar la basura", OPCIONES_MENU), null);
  });

  it("tocar el botón manda el id, y eso resuelve", () => {
    // Es el caso limpio: el vecino tocó, no hay nada que interpretar.
    assert.equal(resolverOpcion("retiro_no_habitual", OPCIONES_MENU), "retiro_no_habitual");
  });
});
