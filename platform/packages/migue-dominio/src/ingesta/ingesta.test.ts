import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  esTituloMarcado,
  MARCA_TITULO,
  marcarTitulo,
  normalizarEspacios,
  pareceTitulo,
  quitarMarca,
  quitarRepetidos,
  unirGuionesDeSilaba,
} from "./texto.ts";
import { fragmentar } from "./fragmentar.ts";
import { extraerDocx } from "./docx.ts";
import { strToU8, zipSync } from "fflate";

describe("unirGuionesDeSilaba", () => {
  it("une la palabra cortada al final de línea", () => {
    assert.equal(unirGuionesDeSilaba("recolec-\nción"), "recolección");
    assert.equal(unirGuionesDeSilaba("contamina-\nción del aire"), "contaminación del aire");
  });

  it("NO toca el guion que es parte de la palabra", () => {
    // «Plan Rector 2023-2030» y «SE-PA-RÁ» son el nombre de las cosas. Unirlos
    // rompería exactamente los términos con los que el vecino busca.
    assert.equal(unirGuionesDeSilaba("Plan Rector 2023-2030"), "Plan Rector 2023-2030");
    assert.equal(unirGuionesDeSilaba("programa SE-PA-RÁ vigente"), "programa SE-PA-RÁ vigente");
  });

  it("une cuando la segunda mitad arranca en mayúscula", () => {
    assert.equal(unirGuionesDeSilaba("Tucu-\nMán"), "TucuMán");
  });

  it("no une un guion suelto con salto de línea", () => {
    // Un guion de lista al final de línea no es corte de sílaba.
    assert.equal(unirGuionesDeSilaba("total -\n5 bolsas"), "total -\n5 bolsas");
  });
});

describe("quitarRepetidos", () => {
  it("quita la línea que aparece en la mayoría de las páginas", () => {
    const paginas = [
      "PLAN RECTOR 2023-2030\nprimera parte",
      "PLAN RECTOR 2023-2030\nsegunda parte",
      "PLAN RECTOR 2023-2030\ntercera parte",
      "PLAN RECTOR 2023-2030\ncuarta parte",
    ];
    const limpias = quitarRepetidos(paginas);
    for (const pagina of limpias) assert.ok(!pagina.includes("PLAN RECTOR"));
    assert.ok(limpias[0]?.includes("primera parte"));
    assert.ok(limpias[3]?.includes("cuarta parte"));
  });

  it("NO quita una línea de contenido que se repite poco", () => {
    const paginas = [
      "los residuos se separan\nuno",
      "dos",
      "tres",
      "cuatro",
      "cinco",
      "los residuos se separan\nseis",
    ];
    const limpias = quitarRepetidos(paginas);
    assert.ok(limpias.join("\n").includes("los residuos se separan"));
  });

  it("con menos de cuatro páginas no hace nada", () => {
    // Con dos o tres páginas, cualquier línea repetida cae por encima del
    // umbral y se borraría contenido real.
    const paginas = ["igual\ntexto a", "igual\ntexto b"];
    assert.deepEqual(quitarRepetidos(paginas), paginas);
  });
});

describe("normalizarEspacios", () => {
  it("conserva el límite de párrafo", () => {
    // El salto doble es donde el fragmentador corta. Colapsarlo dejaría el
    // documento como un solo bloque imposible de fragmentar bien.
    assert.equal(normalizarEspacios("uno\n\n\n\ndos"), "uno\n\ndos");
  });

  it("colapsa espacios y quita los invisibles del PDF", () => {
    assert.equal(normalizarEspacios("uno   dos tres"), "uno dos tres");
  });
});

describe("marca de título", () => {
  it("ida y vuelta", () => {
    const marcado = marcarTitulo("  4. Contenedores  ");
    assert.ok(esTituloMarcado(marcado));
    assert.equal(quitarMarca(marcado), "4. Contenedores");
  });

  it("una línea sin marcar no está marcada", () => {
    assert.equal(esTituloMarcado("4. Contenedores"), false);
  });

  it("la marca sobrevive a la normalización de espacios", () => {
    // Si `normalizarEspacios` se comiera la marca, el fragmentador perdería
    // todos los títulos que detectó el extractor por tamaño de tipografía.
    const marcado = marcarTitulo("Implementación del CONTROLÁ");
    assert.ok(esTituloMarcado(normalizarEspacios(marcado)));
  });
});

describe("pareceTitulo", () => {
  it("la numeración sola alcanza", () => {
    // Éste es el caso que falló al medir sobre el corpus: pidiendo dos señales,
    // «1. Recolección domiciliaria» no se detectaba y los fragmentos quedaban
    // etiquetados con el título de la tapa en vez de con su sección.
    assert.ok(pareceTitulo("1. Recolección domiciliaria"));
    assert.ok(pareceTitulo("4. Contenedores"));
    assert.ok(pareceTitulo("2.3 Barrido manual"));
    assert.ok(pareceTitulo("Capítulo 4 residuos"));
  });

  it("las mayúsculas con cuerpo alcanzan", () => {
    assert.ok(pareceTitulo("MARCO NORMATIVO"));
  });

  it("una sigla suelta no es un título", () => {
    assert.equal(pareceTitulo("RSU"), false);
    assert.equal(pareceTitulo("GPS"), false);
  });

  it("una oración no es un título", () => {
    assert.equal(pareceTitulo("El programa se implementa por etapas."), false);
    assert.equal(pareceTitulo("Los residuos son retirados el martes"), false);
  });

  it("una firma no es un título", () => {
    // Una firma cumple todo lo que pide la señal débil: es corta, está
    // capitalizada y no tiene verbos. Se descarta por el tratamiento, que es
    // lo único que la distingue de un título de sección. Cada PDF del Plan
    // Rector trae una página de autoridades llena de estos casos.
    assert.equal(pareceTitulo("Dra. Rossana Chahla"), false);
    assert.equal(pareceTitulo("Ing. Juan Pérez"), false);
    assert.equal(pareceTitulo("Lic Mariana Soto"), false);
  });
});

describe("fragmentar", () => {
  /** Párrafo de largo pedido, con palabras de verdad para que se pueda partir. */
  function parrafo(caracteres: number): string {
    const base = "los residuos no habituales se retiran con turno previo. ";
    return base.repeat(Math.ceil(caracteres / base.length)).slice(0, caracteres).trim();
  }

  it("el título de sección etiqueta lo que viene después", () => {
    const frags = fragmentar([
      [marcarTitulo("4. Contenedores"), parrafo(300)].join("\n\n"),
    ]);
    assert.equal(frags.length, 1);
    assert.equal(frags[0]?.tituloSeccion, "4. Contenedores");
  });

  it("un título CIERRA el fragmento anterior", () => {
    // Mezclar dos secciones en un fragmento hace que el modelo cite una
    // sección hablando de otra.
    const frags = fragmentar([
      [
        marcarTitulo("Recolección domiciliaria"),
        parrafo(200),
        marcarTitulo("Contenedores"),
        parrafo(200),
      ].join("\n\n"),
    ]);
    assert.equal(frags.length, 2);
    assert.equal(frags[0]?.tituloSeccion, "Recolección domiciliaria");
    assert.equal(frags[1]?.tituloSeccion, "Contenedores");
  });

  it("los fragmentos SÍ cruzan páginas, y guardan la página de INICIO", () => {
    // Los párrafos de estos documentos siguen de una página a la otra. Cortar
    // en el límite de página partiría oraciones por un motivo tipográfico.
    const frags = fragmentar([
      [marcarTitulo("Recolección"), parrafo(300)].join("\n\n"),
      parrafo(300),
    ]);
    assert.equal(frags.length, 1, "los dos párrafos entran en un fragmento");
    assert.equal(frags[0]?.pagina, 1, "guarda la página donde empieza");
    assert.ok(frags[0]!.texto.length > 550, "tiene el contenido de las dos páginas");
  });

  it("ningún fragmento pasa el máximo", () => {
    const frags = fragmentar([parrafo(9000)], { maximo: 1000 });
    assert.ok(frags.length > 1);
    for (const f of frags) assert.ok(f.texto.length <= 1000, `mide ${f.texto.length}`);
  });

  it("parte una enumeración sin puntuación sin perder texto", () => {
    // Sin punto no hay límite de oración; hay que cortar por palabra igual.
    const sinPuntos = Array.from({ length: 300 }, (_, i) => `item${i}`).join(" ");
    const frags = fragmentar([sinPuntos], { maximo: 400 });
    for (const f of frags) assert.ok(f.texto.length <= 400);
    const unido = frags.map((f) => f.texto).join(" ");
    assert.ok(unido.includes("item0"), "no perdió el principio");
    assert.ok(unido.includes("item299"), "no perdió el final");
  });

  it("descarta el índice con puntos suspensivos", () => {
    // Es el peor fragmento posible: enumera todos los títulos del documento,
    // matchea casi cualquier consulta y no contiene ninguna respuesta.
    const indice = [
      "Presentación..........................................  7",
      "Antecedentes.........................................  12",
      "Contenedores.........................................  24",
      "Campañas.............................................  34",
    ].join("\n");
    const frags = fragmentar([[marcarTitulo("ÍNDICE"), indice].join("\n\n")]);
    assert.equal(frags.length, 0);
  });

  it("descarta un fragmento demasiado corto que no se puede pegar a nada", () => {
    const frags = fragmentar([[marcarTitulo("AUTORIDADES"), "ROSSANA CHAHLA 2023"].join("\n\n")]);
    assert.equal(frags.length, 0);
  });

  it("absorbe un fragmento corto en el anterior de la MISMA sección", () => {
    const frags = fragmentar([
      [marcarTitulo("Contenedores"), parrafo(850), "Son 46 en total."].join("\n\n"),
    ]);
    assert.equal(frags.length, 1, "el sobrante corto se pegó, no quedó suelto");
    assert.ok(frags[0]!.texto.includes("Son 46 en total."), "y no se perdió");
  });

  it("el orden es contiguo desde 1 aunque se descarten fragmentos", () => {
    // `orden` tiene un índice único junto al documento: un hueco rompería la
    // reindexación y un duplicado rompería el insert.
    const frags = fragmentar([
      [marcarTitulo("ÍNDICE"), "Uno.......  7\nDos.......  9"].join("\n\n"),
      [marcarTitulo("Contenedores"), parrafo(400)].join("\n\n"),
      [marcarTitulo("Barrido"), parrafo(400)].join("\n\n"),
    ]);
    assert.deepEqual(
      frags.map((f) => f.orden),
      frags.map((_, i) => i + 1),
    );
  });

  it("no deja marcas de control en el texto guardado", () => {
    // La marca es interna. Si llega a la base entra al tsvector y, peor, se le
    // muestra al vecino en la respuesta.
    const frags = fragmentar([[marcarTitulo("Contenedores"), parrafo(400)].join("\n\n")]);
    for (const f of frags) {
      assert.ok(!f.texto.includes(MARCA_TITULO), "el texto quedó con la marca");
      assert.ok(!f.tituloSeccion?.includes(MARCA_TITULO), "el título quedó con la marca");
    }
  });

  it("un documento vacío no rompe", () => {
    assert.deepEqual(fragmentar([]), []);
    assert.deepEqual(fragmentar(["", "   ", "\n\n"]), []);
  });

  it("estima tokens de forma creciente", () => {
    const frags = fragmentar([[marcarTitulo("Contenedores"), parrafo(700)].join("\n\n")]);
    assert.ok(frags[0]!.tokensAprox > 100);
    assert.ok(frags[0]!.tokensAprox < frags[0]!.texto.length);
  });
});

describe("extraerDocx", () => {
  /**
   * Arma un DOCX mínimo en memoria.
   *
   * Vale la pena construirlo a mano en vez de guardar un archivo de prueba:
   * acá se ve exactamente qué XML produce cada resultado, y el test no depende
   * de un binario que nadie puede leer en una revisión.
   */
  function docx(parrafos: { texto: string; estilo?: string }[]): Uint8Array {
    const cuerpo = parrafos
      .map(({ texto, estilo }) => {
        const propiedades =
          estilo === undefined ? "" : `<w:pPr><w:pStyle w:val="${estilo}"/></w:pPr>`;
        return `<w:p w:rsidR="00000000">${propiedades}<w:r><w:t>${texto}</w:t></w:r></w:p>`;
      })
      .join("");

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${cuerpo}</w:body></w:document>`;

    return zipSync({ "word/document.xml": strToU8(xml) });
  }

  /** Párrafo largo para que el fragmento no caiga por debajo del mínimo. */
  const relleno = "El retiro de residuos no habituales se coordina con turno previo. ".repeat(6);

  it("usa el ESTILO del párrafo para detectar el encabezado", () => {
    // Éste es el caso que se rompió sin que nada avisara: el `\b` del patrón
    // quedó guardado como carácter de retroceso real, el regex dejó de coincidir
    // y los nueve encabezados de la especificación pasaron a cero. Los tamaños
    // de los fragmentos casi no cambiaron, así que sólo se notaba mirando las
    // secciones.
    const frags = fragmentar(
      extraerDocx(
        docx([
          { texto: "Reglas Globales de Negocio", estilo: "Heading2" },
          { texto: relleno },
        ]),
      ).paginas,
    );
    assert.equal(frags.length, 1);
    assert.equal(frags[0]?.tituloSeccion, "Reglas Globales de Negocio");
  });

  it("acepta los estilos de un Word en español", () => {
    // Word nombra el estilo según el idioma en que se creó el documento, y los
    // archivos de Ambiente llegan de máquinas distintas.
    for (const estilo of ["Ttulo1", "Titulo2", "Título3", "Heading1"]) {
      const frags = fragmentar(
        extraerDocx(docx([{ texto: "Marco Normativo", estilo }, { texto: relleno }])).paginas,
      );
      assert.equal(frags[0]?.tituloSeccion, "Marco Normativo", `falló con estilo ${estilo}`);
    }
  });

  it("un párrafo con estilo de cuerpo NO es un encabezado", () => {
    const frags = fragmentar(
      extraerDocx(
        docx([{ texto: "Reglas Globales", estilo: "BodyText" }, { texto: relleno }]),
      ).paginas,
    );
    assert.equal(frags[0]?.tituloSeccion, null);
  });

  it("descomprime tablas y notas al pie", () => {
    const extraido = extraerDocx(docx([{ texto: "los contenedores son 46 en total" }]));
    assert.ok(extraido.paginas[0]?.includes("46 en total"));
    assert.equal(extraido.cantidadPaginas, 1);
  });

  it("un archivo que no es DOCX falla con un mensaje claro", () => {
    // El panel deja subir cualquier cosa; el mensaje termina en la fila del
    // trabajo y lo lee un administrador, no un programador.
    const zipVacio = zipSync({ "hola.txt": strToU8("no soy un docx") });
    assert.throws(() => extraerDocx(zipVacio), /no parece un DOCX/);
  });
});
