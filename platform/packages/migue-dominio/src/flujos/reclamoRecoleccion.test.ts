import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flujoReclamoRecoleccion as flujo } from "./reclamoRecoleccion.ts";
import { AHORA, catalogoPrueba, contextoPrueba, dijo, efectoDe, simular } from "./_fixtures.ts";
import { configSla } from "../datos/catalogo.ts";
import { esDiaHabil } from "../reglas/sla.ts";

describe("apertura", () => {
  it("pide los tres datos del diagnóstico en un solo mensaje", () => {
    const s = simular(flujo, []);
    assert.equal(s.dichos.length, 1, "no fragmenta el pedido en tres preguntas");
    assert.match(s.dichos[0]!, /direcci[oó]n/i);
  });

  it("suma el enlace a los recorridos sólo si está cargado", () => {
    // Ambiente todavía no nos pasó la URL del mapa. Sin este condicional el
    // vecino recibiría el marcador «[falta texto: ...]».
    const sinEnlace = simular(flujo, []);
    assert.equal(sinEnlace.dichos.length, 1);
    assert.equal(dijo(sinEnlace.dichos, "falta texto"), false);

    const textos = new Map(catalogoPrueba().textos);
    textos.set("reclamo_info_turnos", "Verificá tu turno en el mapa: ejemplo.gob.ar/mapa");
    const conEnlace = simular(flujo, [], contextoPrueba(catalogoPrueba({ textos })));
    assert.equal(conEnlace.dichos.length, 2);
    assert.ok(dijo(conEnlace.dichos, "mapa"));
  });
});

describe("la dirección es lo único bloqueante", () => {
  it("con sólo la dirección ya genera el reclamo", () => {
    const s = simular(flujo, [{ texto: "Lavalle al 500" }]);
    assert.equal(s.estado, null, "el flujo terminó");
    assert.equal(efectoDe(s.efectos, "crear_ticket")?.datos.direccion, "Lavalle 500");
  });

  it("sin dirección no genera nada", () => {
    const s = simular(flujo, [{ texto: "no pasa el camion hace 3 dias" }]);
    assert.equal(s.estado?.paso, "diagnostico");
    assert.equal(efectoDe(s.efectos, "crear_ticket"), undefined);
  });

  it("repregunta nombrando la calle si falta la altura", () => {
    const s = simular(flujo, [{ texto: "Lavalle" }]);
    assert.ok(dijo(s.dichos, "altura de Lavalle"));
  });
});

describe("la foto es opcional, a diferencia del flujo A", () => {
  it("sin foto el reclamo se registra igual", () => {
    // La spec dice «opcional pero deseable». Exigirla dejaría afuera al vecino
    // que ya guardó la bolsa; la falla se verifica con el GPS del interno.
    const s = simular(flujo, [{ texto: "Lavalle 500" }]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.fotoReferencia, null);
    assert.equal(efectoDe(s.efectos, "guardar_media"), undefined);
  });

  it("con foto y dirección juntas registra las dos cosas", () => {
    const s = simular(flujo, [{ texto: "Bolivar 350", imagen: "foto-b1" }]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.fotoReferencia, "foto-b1");
    assert.equal(efectoDe(s.efectos, "guardar_media")?.referencia, "foto-b1");
  });

  it("REGRESIÓN · foto primero y dirección después: no pierde la foto", () => {
    const s = simular(flujo, [{ imagen: "foto-b2" }, { texto: "Salta 45" }]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.fotoReferencia, "foto-b2", "la foto sobrevivió al turno intermedio");
    assert.equal(t.direccion, "Salta 45");
  });

  it("si mandó sólo la foto, el pedido de dirección lo reconoce", () => {
    const s = simular(flujo, [{ imagen: "foto-b3" }]);
    assert.ok(dijo(s.dichos, "Recibí la foto"), "no ignora lo que ya mandó");
  });
});

describe("cuántos días hace que no pasan", () => {
  it("lee un número explícito", () => {
    const s = simular(flujo, [{ texto: "Lavalle 500, hace 3 dias que no pasan" }]);
    assert.equal(efectoDe(s.efectos, "crear_ticket")?.datos.diasSinServicio, 3);
  });

  it("lee números escritos con palabras", () => {
    const s = simular(flujo, [{ texto: "Lavalle 500, hace cuatro dias" }]);
    assert.equal(efectoDe(s.efectos, "crear_ticket")?.datos.diasSinServicio, 4);
  });

  it("convierte semanas a días", () => {
    assert.equal(
      efectoDe(simular(flujo, [{ texto: "Muñecas 200, hace una semana" }]).efectos, "crear_ticket")
        ?.datos.diasSinServicio,
      7,
    );
    assert.equal(
      efectoDe(simular(flujo, [{ texto: "Salta 45, hace dos semanas" }]).efectos, "crear_ticket")
        ?.datos.diasSinServicio,
      14,
    );
  });

  it("REGRESIÓN · no confunde la altura con la cantidad de días", () => {
    // «Muñecas 200, hace una semana» tiene dos números y sólo uno es la
    // respuesta. Antes se leía el 200 de la dirección como días.
    const s = simular(flujo, [{ texto: "Muñecas 200, hace una semana" }]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.diasSinServicio, 7);
    assert.equal(t.direccion, "Muñecas 200");
  });

  it("descarta plazos que no son del servicio diario", () => {
    // Seis meses sin recolección no es una falla del recorrido diario: es otro
    // problema, y registrarlo como éste falsearía las métricas.
    const s = simular(flujo, [{ texto: "Lavalle 500, hace 6 meses" }]);
    assert.equal(efectoDe(s.efectos, "crear_ticket")?.datos.diasSinServicio, null);
  });

  it("es opcional: sin el dato el reclamo se registra igual", () => {
    const s = simular(flujo, [{ texto: "Lavalle 500" }]);
    assert.equal(efectoDe(s.efectos, "crear_ticket")?.datos.diasSinServicio, null);
  });
});

describe("el ticket que queda", () => {
  it("es de tipo Falta de Recolección y no arrastra datos del flujo A", () => {
    const s = simular(flujo, [{ texto: "Lavalle 500, hace 2 dias" }]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(t.tipo, "Falta de Recolección");
    assert.equal(t.tipoResiduo, null);
    assert.equal(t.cantidadValor, null);
    assert.equal(t.excedeLimite, false);
    assert.equal(t.retiroParcial, false);
  });

  it("el vencimiento cae en día hábil", () => {
    const s = simular(flujo, [{ texto: "Lavalle 500" }]);
    const t = efectoDe(s.efectos, "crear_ticket")!.datos;
    assert.equal(esDiaHabil(t.vencimiento, configSla(catalogoPrueba())), true);
    assert.ok(t.vencimiento > AHORA);
  });

  it("la confirmación interpola el plazo real y nombra a la empresa", () => {
    const s = simular(flujo, [{ texto: "Lavalle 500" }]);
    const ultimo = s.dichos.at(-1)!;
    assert.ok(dijo([ultimo], "3 días hábiles"));
    assert.ok(dijo([ultimo], "Transporte 9 de Julio"));
    assert.ok(dijo([ultimo], "GPS"), "la spec promete verificar el GPS del interno");
    assert.doesNotMatch(ultimo, /\{\w+\}/, "sin marcadores sueltos");
  });
});
