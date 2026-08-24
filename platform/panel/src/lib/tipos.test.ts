import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estadoVisible, tamanoLegible, type Documento } from "./tipos.ts";

function doc(parcial: Partial<Documento> = {}): Documento {
  return {
    id: "d1",
    titulo: "Plan Rector",
    descripcion: null,
    nombre_archivo: "plan.pdf",
    formato: "pdf",
    ruta_storage: "abc-plan.pdf",
    bytes: 1024,
    hash_sha256: "abc",
    paginas: 24,
    estado: "listo",
    error_detalle: null,
    cantidad_fragmentos: 17,
    activo: true,
    subido_por: null,
    creado_en: "2026-08-01T10:00:00Z",
    actualizado_en: "2026-08-01T10:00:00Z",
    ...parcial,
  };
}

/** Momento fijo, para que el test no dependa del reloj de la máquina. */
const AHORA = new Date("2026-08-01T10:05:00Z").getTime();

describe("estadoVisible", () => {
  it("traduce el estado, no muestra el enum", () => {
    // «procesando» no le dice nada a nadie del área de Ambiente.
    assert.equal(estadoVisible(doc({ estado: "pendiente" }), AHORA).etiqueta, "en cola");
    assert.equal(
      estadoVisible(doc({ estado: "procesando" }), AHORA).etiqueta,
      "leyendo el archivo",
    );
  });

  it("en «listo» la etiqueta es el conteo de fragmentos", () => {
    // Es el dato que importa: es lo que Migue puede citar.
    assert.equal(estadoVisible(doc({ cantidad_fragmentos: 33 }), AHORA).etiqueta, "33 fragmentos");
  });

  it("concuerda el singular", () => {
    // Se ve poco pero se ve, y en este corpus hay un documento con un solo
    // fragmento: decía «1 fragmentos».
    assert.equal(estadoVisible(doc({ cantidad_fragmentos: 1 }), AHORA).etiqueta, "1 fragmento");
    assert.equal(estadoVisible(doc({ cantidad_fragmentos: 2 }), AHORA).etiqueta, "2 fragmentos");
  });

  it("«listo» con CERO fragmentos no está listo", () => {
    // El caso del PDF escaneado. Mostrarlo en verde sería mentir.
    const e = estadoVisible(doc({ estado: "listo", cantidad_fragmentos: 0 }), AHORA);
    assert.equal(e.tono, "alerta");
    assert.equal(e.reintentable, true);
  });

  it("detecta el «procesando» eterno", () => {
    // `recuperar_trabajos_colgados` devuelve el trabajo a la cola pasados 15
    // minutos pero NO toca documentos.estado. Sin esto el panel muestra un
    // spinner que nunca termina.
    const viejo = doc({ estado: "procesando", actualizado_en: "2026-08-01T09:00:00Z" });
    const e = estadoVisible(viejo, AHORA);
    assert.equal(e.etiqueta, "parece colgado");
    assert.equal(e.reintentable, true);
    assert.match(e.detalle ?? "", /65 minutos/);
  });

  it("no lo marca colgado si recién arrancó", () => {
    const reciente = doc({ estado: "procesando", actualizado_en: "2026-08-01T10:04:00Z" });
    assert.equal(estadoVisible(reciente, AHORA).etiqueta, "leyendo el archivo");
  });

  it("un error muestra el detalle que escribió el worker", () => {
    const e = estadoVisible(
      doc({ estado: "error", error_detalle: "hay que pasarlo por un OCR" }),
      AHORA,
    );
    assert.equal(e.tono, "alerta");
    assert.equal(e.detalle, "hay que pasarlo por un OCR");
    assert.equal(e.reintentable, true);
  });
});

describe("tamanoLegible", () => {
  it("cubre el rango real del corpus, de 8 KB a 8 MB", () => {
    assert.equal(tamanoLegible(512), "512 B");
    assert.equal(tamanoLegible(8 * 1024), "8 KB");
    assert.equal(tamanoLegible(7922 * 1024), "7.7 MB");
  });
});
