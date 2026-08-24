import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import {
  PayloadInvalidoError,
  procesarTrabajo,
  type DocumentoARindexar,
  type PuertosIngesta,
  type Trabajo,
} from "./procesar.ts";
import { formatoDe, hashDe, FormatoNoSoportadoError } from "./extraer.ts";
import { claveDeStorage } from "./clave.ts";
import { extraer } from "./extraer.ts";

/** sha256 de la cadena vacía: el valor que aparecía cuando pdfjs se quedaba con el buffer. */
const HASH_DEL_VACIO = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** DOCX mínimo con texto suficiente para pasar el umbral de extracción. */
function docxConTexto(): Uint8Array {
  const parrafo =
    "El retiro de residuos no habituales se coordina con turno previo y foto obligatoria. ";
  const cuerpo =
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Retiro No Habitual</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>${parrafo.repeat(8)}</w:t></w:r></w:p>`;
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${cuerpo}</w:body></w:document>`;
  return zipSync({ "word/document.xml": strToU8(xml) });
}

const DOCUMENTO: DocumentoARindexar = {
  id: "doc-1",
  titulo: "Retiro no habitual",
  nombreArchivo: "retiro.docx",
  formato: "docx",
  rutaStorage: "documentos/retiro.docx",
};

interface Espia {
  puertos: PuertosIngesta;
  llamadas: string[];
  fragmentosGuardados: number;
  errorMarcado: string | null;
}

/**
 * Puertos falsos que anotan lo que se les pidió.
 *
 * Se verifican las LLAMADAS y no sólo el resultado: que un documento sin texto
 * devuelva error no alcanza, hay que comprobar que además quedó marcado en la
 * base, porque si no el panel muestra «procesando» para siempre.
 */
function espiar(sobreescribir: Partial<PuertosIngesta> = {}): Espia {
  const espia: Espia = {
    llamadas: [],
    fragmentosGuardados: 0,
    errorMarcado: null,
    puertos: undefined as unknown as PuertosIngesta,
  };

  espia.puertos = {
    async leerDocumento(id) {
      espia.llamadas.push(`leerDocumento(${id})`);
      return DOCUMENTO;
    },
    async marcarProcesando(id) {
      espia.llamadas.push(`marcarProcesando(${id})`);
    },
    async marcarError(id, detalle) {
      espia.llamadas.push(`marcarError(${id})`);
      espia.errorMarcado = detalle;
    },
    async descargar(ruta) {
      espia.llamadas.push(`descargar(${ruta})`);
      return docxConTexto();
    },
    async reemplazarFragmentos(_id, fragmentos) {
      espia.llamadas.push(`reemplazarFragmentos(${fragmentos.length})`);
      espia.fragmentosGuardados = fragmentos.length;
      return fragmentos.length;
    },
    async borrarDocumento(id, ruta) {
      espia.llamadas.push(`borrarDocumento(${id}, ${ruta})`);
    },
    async encolarReindexado() {
      espia.llamadas.push("encolarReindexado()");
      return 8;
    },
    async descargarDeCanal(canal, referencia) {
      espia.llamadas.push(`descargarDeCanal(${canal}, ${referencia})`);
      return { datos: strToU8("bytes de la foto"), mime: "image/jpeg", nombre: "foto.jpg" };
    },
    async guardarMedia(ruta) {
      espia.llamadas.push(`guardarMedia(${ruta})`);
    },
    async registrarMediaGuardada(referencia, ruta) {
      espia.llamadas.push(`registrarMediaGuardada(${referencia} -> ${ruta})`);
      return 1;
    },
    registrar() {},
    ...sobreescribir,
  };

  return espia;
}

function trabajo(parcial: Partial<Trabajo> = {}): Trabajo {
  return {
    id: "trab-1",
    tipo: "ingestar_documento",
    payload: { documento_id: "doc-1" },
    intentos: 1,
    maxIntentos: 3,
    ...parcial,
  };
}

describe("formatoDe", () => {
  it("reconoce los formatos admitidos", () => {
    assert.equal(formatoDe("plan.pdf"), "pdf");
    assert.equal(formatoDe("PLAN.PDF"), "pdf");
    assert.equal(formatoDe("spec.docx"), "docx");
    assert.equal(formatoDe("notas.txt"), "txt");
    assert.equal(formatoDe("LEEME.md"), "md");
  });

  it("rechaza lo que no se puede leer, con un mensaje para el administrador", () => {
    // El panel deja subir cualquier cosa y el mensaje termina en la fila del
    // documento. Un .doc viejo es el caso real más probable.
    assert.throws(() => formatoDe("viejo.doc"), FormatoNoSoportadoError);
    assert.throws(() => formatoDe("escaneo.jpg"), /sólo se admiten PDF, DOCX, TXT y MD/);
    assert.throws(() => formatoDe("sinextension"), FormatoNoSoportadoError);
  });
});

describe("hashDe", () => {
  it("el mismo contenido da el mismo hash", () => {
    assert.equal(hashDe(strToU8("igual")), hashDe(strToU8("igual")));
  });

  it("contenido distinto da hash distinto", () => {
    assert.notEqual(hashDe(strToU8("uno")), hashDe(strToU8("dos")));
  });
});

describe("procesarTrabajo · ingesta", () => {
  it("indexa el documento y guarda los fragmentos", async () => {
    const espia = espiar();
    const resultado = await procesarTrabajo(trabajo(), espia.puertos);

    assert.equal(resultado.ok, true);
    assert.ok(espia.fragmentosGuardados > 0, "no guardó ningún fragmento");
    assert.ok(
      espia.llamadas.includes("marcarProcesando(doc-1)"),
      "no marcó el documento como en proceso, el panel lo mostraría pendiente",
    );
  });

  it("marca en proceso ANTES de bajar el archivo", async () => {
    // Bajar un PDF grande y extraerlo lleva segundos. Si el orden se invirtiera,
    // el panel mostraría «pendiente» todo ese rato y el administrador apretaría
    // reprocesar pensando que se colgó.
    const espia = espiar();
    await procesarTrabajo(trabajo(), espia.puertos);
    const iProcesando = espia.llamadas.indexOf("marcarProcesando(doc-1)");
    const iDescarga = espia.llamadas.findIndex((l) => l.startsWith("descargar("));
    assert.ok(iProcesando >= 0 && iDescarga > iProcesando, espia.llamadas.join(" -> "));
  });

  it("reindexar_documento hace exactamente lo mismo que ingestar", async () => {
    // Un solo camino para los dos tipos: si fueran dos, un arreglo en uno no
    // llegaría al otro.
    const a = espiar();
    await procesarTrabajo(trabajo({ tipo: "ingestar_documento" }), a.puertos);
    const b = espiar();
    await procesarTrabajo(trabajo({ tipo: "reindexar_documento" }), b.puertos);
    assert.deepEqual(a.llamadas, b.llamadas);
  });

  it("un documento borrado mientras esperaba en la cola NO es un error", async () => {
    // Si esto se contara como error, el trabajo se reintentaría tres veces y
    // quedaría en rojo en el panel por haber hecho lo correcto.
    const espia = espiar({ leerDocumento: async () => null });
    const resultado = await procesarTrabajo(trabajo(), espia.puertos);
    assert.equal(resultado.ok, true);
    assert.ok(!espia.llamadas.some((l) => l.startsWith("descargar(")), "intentó bajar igual");
  });

  it("si el archivo no está en el Storage, no se reintenta", async () => {
    // El archivo no va a aparecer solo: reintentar es gastar tres turnos de cola
    // para llegar al mismo lugar.
    const espia = espiar({ descargar: async () => null });
    const resultado = await procesarTrabajo(trabajo(), espia.puertos);

    assert.equal(resultado.ok, false);
    assert.equal(resultado.ok === false && resultado.reintentable, false);
    assert.ok(espia.errorMarcado?.includes("volver a subirlo"), espia.errorMarcado ?? "(sin error)");
  });

  it("un PDF escaneado da un error definitivo y explicado", async () => {
    // Un escaneo sin capa de texto es el caso de soporte más probable. El
    // mensaje tiene que decir qué hacer, porque lo lee alguien del área y no un
    // programador.
    const espia = espiar({
      descargar: async () => zipSync({ "word/document.xml": strToU8("<w:document/>") }),
    });
    const resultado = await procesarTrabajo(trabajo(), espia.puertos);

    assert.equal(resultado.ok, false);
    assert.equal(resultado.ok === false && resultado.reintentable, false);
    assert.ok(espia.errorMarcado?.includes("OCR"), espia.errorMarcado ?? "(sin error)");
    assert.ok(espia.llamadas.includes("marcarError(doc-1)"));
  });

  it("un fallo de red SÍ se reintenta", async () => {
    // La distinción es lo importante: contenido malo no se reintenta, red sí.
    const espia = espiar({
      descargar: async () => {
        throw new Error("fetch failed");
      },
    });
    const resultado = await procesarTrabajo(trabajo(), espia.puertos);
    assert.equal(resultado.ok, false);
    assert.equal(resultado.ok === false && resultado.reintentable, true);
  });

  it("un payload sin documento_id no se reintenta", async () => {
    const espia = espiar();
    const resultado = await procesarTrabajo(trabajo({ payload: {} }), espia.puertos);
    assert.equal(resultado.ok, false);
    assert.equal(resultado.ok === false && resultado.reintentable, false);
    assert.ok(resultado.ok === false && resultado.error.includes("documento_id"));
  });

  it("PayloadInvalidoError nombra el trabajo y el campo", () => {
    const error = new PayloadInvalidoError("ingestar_documento", "documento_id");
    assert.match(error.message, /ingestar_documento/);
    assert.match(error.message, /documento_id/);
  });
});

describe("procesarTrabajo · borrado", () => {
  it("borra el documento y su archivo", async () => {
    const espia = espiar();
    const resultado = await procesarTrabajo(trabajo({ tipo: "borrar_documento" }), espia.puertos);
    assert.equal(resultado.ok, true);
    assert.ok(
      espia.llamadas.includes("borrarDocumento(doc-1, documentos/retiro.docx)"),
      espia.llamadas.join(" -> "),
    );
  });

  it("usa la ruta del payload si el documento ya no está en la base", async () => {
    // Sin esto, borrar dos veces dejaría el archivo huérfano en el Storage
    // ocupando cuota para siempre.
    const espia = espiar({ leerDocumento: async () => null });
    await procesarTrabajo(
      trabajo({
        tipo: "borrar_documento",
        payload: { documento_id: "doc-1", ruta_storage: "documentos/huerfano.pdf" },
      }),
      espia.puertos,
    );
    assert.ok(
      espia.llamadas.includes("borrarDocumento(doc-1, documentos/huerfano.pdf)"),
      espia.llamadas.join(" -> "),
    );
  });

  it("sin ruta en ningún lado, borra igual las filas", async () => {
    const espia = espiar({ leerDocumento: async () => null });
    const resultado = await procesarTrabajo(trabajo({ tipo: "borrar_documento" }), espia.puertos);
    assert.equal(resultado.ok, true);
    assert.ok(espia.llamadas.includes("borrarDocumento(doc-1, null)"));
  });
});

describe("procesarTrabajo · reindexado masivo", () => {
  it("encola uno por documento y no reindexa nada él mismo", async () => {
    const espia = espiar();
    const resultado = await procesarTrabajo(trabajo({ tipo: "reindexar_todo" }), espia.puertos);
    assert.equal(resultado.ok, true);
    assert.deepEqual(espia.llamadas, ["encolarReindexado()"]);
    assert.ok(resultado.ok && resultado.detalle.includes("8"));
  });
});

describe("claveDeStorage", () => {
  const hash = "c8114c85aaaabbbbccccddddeeeeffff00001111222233334444555566667777";

  it("saca los acentos, que Supabase rechaza con «Invalid key»", () => {
    // Caso real: «Documento sin título.docx» falló al subir el corpus.
    const clave = claveDeStorage("Documento sin título.docx", hash);
    assert.equal(clave, "c8114c85-Documento-sin-titulo.docx");
    assert.match(clave, /^[A-Za-z0-9._-]+$/, "quedaron caracteres que Storage no acepta");
  });

  it("recorta un nombre larguísimo pero conserva la extensión", () => {
    // El otro caso real: el workflow de reclamos tiene 200 caracteres de nombre.
    const largo =
      "El workflow para el bot de residuos no habituales, reclamo de no recolección " +
      "(pasó el recolector y no recogió mi bolsa, o no pasó), debe existir en whatsapp.docx";
    const clave = claveDeStorage(largo, hash);
    assert.ok(clave.length <= 90, `mide ${clave.length}`);
    assert.ok(clave.endsWith(".docx"), clave);
    assert.match(clave, /^[A-Za-z0-9._-]+$/);
    assert.ok(clave.includes("El-workflow"), "perdió el parecido con el original");
  });

  it("no deja guiones ni puntos colgando en los bordes", () => {
    for (const nombre of ["«Ordenanza N° 4.512 — Residuos».pdf", "   espacios   .pdf", "---.pdf"]) {
      const clave = claveDeStorage(nombre, hash);
      assert.doesNotMatch(clave, /[-.]{2}/, `${clave} tiene separadores repetidos`);
      assert.doesNotMatch(clave, /-\./, `${clave} tiene un guion antes de la extensión`);
      assert.match(clave, /^[A-Za-z0-9._-]+$/, clave);
    }
  });

  it("un nombre que es todo puntuación igual da una clave válida", () => {
    const clave = claveDeStorage("«»—.pdf", hash);
    assert.equal(clave, "c8114c85-documento.pdf");
  });

  it("el prefijo distingue dos archivos con el mismo nombre", () => {
    const otro = "ffffffffaaaabbbbccccddddeeeeffff00001111222233334444555566667777";
    assert.notEqual(claveDeStorage("informe.pdf", hash), claveDeStorage("informe.pdf", otro));
  });

  it("un archivo sin extensión no rompe", () => {
    assert.equal(claveDeStorage("LEEME", hash), "c8114c85-LEEME");
  });
});

describe("extraer · el hash sobrevive a la extracción", () => {
  it("un PDF se guarda con el hash de SU contenido, no con el del vacío", async () => {
    // El bug: `pdfjs` se apropia del ArrayBuffer y lo deja desacoplado, así que
    // calcular el hash después de extraer devolvía siempre
    // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855, que es
    // el sha256 de la cadena vacía. Con un índice único sobre
    // `documentos.hash_sha256`, el primer PDF se guardaba con ese hash y el
    // segundo chocaba y no se indexaba nunca.
    //
    // Este test usa el corpus real porque el bug necesita un PDF de verdad: un
    // PDF inventado no hace que pdfjs tome posesión del buffer.
    const ruta = path.join(
      process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".",
      "ambiente/corpus/Ambiente - Residuos no Habituales",
      "Datos de entrenamiento Chatbot Ambiente/aonxhSOrXNzurOiYcOWE.pdf",
    );
    if (!fs.existsSync(ruta)) {
      // El corpus no está versionado: en otra máquina este test no aplica.
      return;
    }

    const datos = new Uint8Array(fs.readFileSync(ruta));
    const esperado = hashDe(datos);
    assert.notEqual(esperado, HASH_DEL_VACIO, "el archivo de prueba no puede estar vacío");

    const resultado = await extraer(datos, "aonxhSOrXNzurOiYcOWE.pdf");

    assert.equal(resultado.hash, esperado, "el hash no es el del contenido del PDF");
    assert.notEqual(resultado.hash, HASH_DEL_VACIO, "guardó el hash del vacío");
    assert.ok(resultado.fragmentos.length > 20, "además tenía que extraer el texto");
  });

  it("dos PDFs distintos dan hashes distintos", async () => {
    // Es la consecuencia que importa: con el bug, los tres PDFs del corpus daban
    // el MISMO hash y el índice único dejaba entrar sólo al primero.
    const base = path.join(
      process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".",
      "ambiente/corpus/Ambiente - Residuos no Habituales/Datos de entrenamiento Chatbot Ambiente",
    );
    const uno = path.join(base, "QBaZninxWuexyJcS6s0i.pdf");
    const dos = path.join(base, "UQNV8gvyAKsepwqXnoBX.pdf");
    if (!fs.existsSync(uno) || !fs.existsSync(dos)) return;

    const a = await extraer(new Uint8Array(fs.readFileSync(uno)), "a.pdf");
    const b = await extraer(new Uint8Array(fs.readFileSync(dos)), "b.pdf");

    assert.notEqual(a.hash, b.hash);
    assert.notEqual(a.hash, HASH_DEL_VACIO);
    assert.notEqual(b.hash, HASH_DEL_VACIO);
  });

  it("un DOCX también conserva su hash", async () => {
    const datos = docxConTexto();
    const esperado = hashDe(datos);
    const resultado = await extraer(datos, "prueba.docx");
    assert.equal(resultado.hash, esperado);
  });
});

describe("procesarTrabajo · el documento nunca queda en «procesando»", () => {
  it("si falla el guardado, el documento queda en error y no girando", async () => {
    // Sin esto el panel muestra el documento «procesando» para siempre, mientras
    // el trabajo figura en «error»: dos estados que se contradicen y nadie sabe
    // cuál creer. Pasó al indexar el corpus con dos PDFs.
    const espia = espiar({
      async reemplazarFragmentos() {
        throw new Error('duplicate key value violates unique constraint "documentos_hash_unico"');
      },
    });
    const resultado = await procesarTrabajo(trabajo(), espia.puertos);

    assert.equal(resultado.ok, false);
    assert.ok(
      espia.llamadas.includes("marcarError(doc-1)"),
      `quedó en procesando: ${espia.llamadas.join(" -> ")}`,
    );
    assert.ok(espia.errorMarcado?.includes("documentos_hash_unico"));
  });

  it("todo camino de falla marca el documento, salvo que ni exista", async () => {
    // Barrido de los cuatro modos de falla. El que no marca es el del documento
    // borrado, y ahí es correcto: no hay fila que marcar.
    const casos = [
      ["archivo ausente", { descargar: async () => null }, true],
      [
        "sin texto",
        { descargar: async () => zipSync({ "word/document.xml": strToU8("<w:document/>") }) },
        true,
      ],
      [
        "falla el guardado",
        {
          async reemplazarFragmentos(): Promise<number> {
            throw new Error("se cayó la base");
          },
        },
        true,
      ],
      ["documento borrado", { leerDocumento: async () => null }, false],
    ] as const;

    for (const [nombre, sobre, deberiaMarcar] of casos) {
      const espia = espiar(sobre);
      await procesarTrabajo(trabajo(), espia.puertos);
      const marco = espia.llamadas.includes("marcarError(doc-1)");
      assert.equal(marco, deberiaMarcar, `«${nombre}»: ${espia.llamadas.join(" -> ")}`);
    }
  });
});

describe("procesarTrabajo · foto de un vecino", () => {
  function trabajoFoto(payload: Record<string, unknown> = {}): Trabajo {
    return trabajo({
      tipo: "descargar_media",
      payload: {
        clase: "media_de_canal",
        referencia: "AgACAgEAAxkBAAIBY2Vm",
        proposito: "retiro_no_habitual",
        canal: "telegram",
        conversacion_id: "conv-1",
        ...payload,
      },
    });
  }

  it("baja la foto, la guarda y la anota en el ticket", async () => {
    // Va por la cola porque el vecino no tiene que esperar a que bajen 5 MB
    // antes de recibir la confirmación de su pedido.
    const espia = espiar();
    const resultado = await procesarTrabajo(trabajoFoto(), espia.puertos);

    assert.equal(resultado.ok, true);
    const orden = espia.llamadas.join(" -> ");
    assert.match(orden, /descargarDeCanal\(telegram,/);
    assert.match(orden, /guardarMedia\(retiro_no_habitual\//, orden);
    assert.match(orden, /registrarMediaGuardada\(/, orden);
  });

  it("agrupa por propósito y sanea la referencia en la ruta", async () => {
    // La referencia de Telegram trae caracteres que Storage rechaza, el mismo
    // problema que ya apareció con los nombres de documento.
    const espia = espiar();
    await procesarTrabajo(
      trabajoFoto({ referencia: "AgAC/Ag+EAA=xkB", proposito: "reclamo" }),
      espia.puertos,
    );
    const guardado = espia.llamadas.find((l) => l.startsWith("guardarMedia("))!;
    assert.ok(guardado.startsWith("guardarMedia(reclamo/"), guardado);
    assert.doesNotMatch(guardado.slice("guardarMedia(".length), /[^A-Za-z0-9._\-/()]/, guardado);
  });

  it("si el canal ya no tiene el archivo, NO se reintenta", async () => {
    // Telegram y WhatsApp vencen sus archivos. Reintentar tres veces es gastar
    // turnos de cola para llegar al mismo lugar.
    const espia = espiar({ descargarDeCanal: async () => null });
    const resultado = await procesarTrabajo(trabajoFoto(), espia.puertos);

    assert.equal(resultado.ok, false);
    assert.equal(resultado.ok === false && resultado.reintentable, false);
    assert.ok(!espia.llamadas.some((l) => l.startsWith("guardarMedia")), "guardó igual");
  });

  it("cero filas actualizadas NO es un error", async () => {
    // El vecino pudo mandar la foto y abandonar antes de generar el ticket. La
    // foto se guarda igual; perderla sería peor.
    const espia = espiar({ registrarMediaGuardada: async () => 0 });
    const resultado = await procesarTrabajo(trabajoFoto(), espia.puertos);
    assert.equal(resultado.ok, true);
  });

  it("un payload sin referencia o sin canal no se reintenta", async () => {
    for (const roto of [{ referencia: "" }, { canal: "" }]) {
      const espia = espiar();
      const resultado = await procesarTrabajo(trabajoFoto(roto), espia.puertos);
      assert.equal(resultado.ok, false, JSON.stringify(roto));
      assert.equal(resultado.ok === false && resultado.reintentable, false);
    }
  });

  it("un fallo de red al bajar SÍ se reintenta", async () => {
    const espia = espiar({
      descargarDeCanal: async () => {
        throw new Error("socket hang up");
      },
    });
    const resultado = await procesarTrabajo(trabajoFoto(), espia.puertos);
    assert.equal(resultado.ok === false && resultado.reintentable, true);
  });
});
