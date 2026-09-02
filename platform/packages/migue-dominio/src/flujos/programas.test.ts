import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  flujoProgramaEduca,
  flujoProgramaSepara,
  flujoProgramaTransforma,
} from "./programas.ts";
import { dijo, efectoDe, simular } from "./_fixtures.ts";

describe("EDUCÁ · talleres y visitas", () => {
  it("con todos los datos en un mensaje registra la solicitud", () => {
    // El caso real: el vecino escribe todo junto. Volver a preguntarle algo que
    // ya escribió es exactamente la queja del documento de QA.
    const s = simular(flujoProgramaEduca, [
      {
        texto:
          "Escuela Normal Juan B Alberdi, Muñecas 200, responsable Ramiro Sosa, 30 alumnos, tel 3814440055",
      },
    ]);
    assert.equal(s.estado, null, "cerró en un solo turno");

    const d = efectoDe(s.efectos, "crear_solicitud_programa")!.datos;
    assert.equal(d.programa, "educa");
    assert.equal(d.direccion, "Muñecas 200");
    assert.equal(d.institucion, "Escuela Normal Juan B Alberdi");
    assert.equal(d.cantidadAlumnos, 30);
    assert.equal(d.telefonoContacto, "3814440055");
  });

  it("REGRESIÓN · la dirección no se confunde con el teléfono", () => {
    // El buscador por segmentos tomaba «tel 381 4440012» como calle «tel»,
    // altura 381 — y ganaba sobre la dirección real, que venía después.
    const s = simular(flujoProgramaEduca, [
      { texto: "tel 381 4440012, Colegio San Miguel, Bolivar 350, 25 chicos" },
    ]);
    const d = efectoDe(s.efectos, "crear_solicitud_programa")!.datos;
    assert.equal(d.direccion, "Bolivar 350");
    assert.equal(d.telefonoContacto, "381 4440012");
  });

  it("guarda el texto completo, porque la spec manda mail a administración", () => {
    const s = simular(flujoProgramaEduca, [
      { texto: "Jardin Los Pinos, Salta 45, viene la seño Marta, 18 niños" },
    ]);
    const d = efectoDe(s.efectos, "crear_solicitud_programa")!.datos;
    assert.match(d.informacionAdicional ?? "", /seño Marta/, "no se pierde lo no estructurado");
  });

  it("sin dirección repregunta y conserva lo ya dicho", () => {
    const s = simular(flujoProgramaEduca, [
      { texto: "Escuela Normal, 30 alumnos" },
      { texto: "Muñecas 200" },
    ]);
    const d = efectoDe(s.efectos, "crear_solicitud_programa")!.datos;
    assert.equal(d.direccion, "Muñecas 200");
    assert.equal(d.institucion, "Escuela Normal", "recordó la institución del turno anterior");
    assert.equal(d.cantidadAlumnos, 30, "y la cantidad de alumnos");
  });

  it("números escritos con palabras", () => {
    const s = simular(flujoProgramaEduca, [{ texto: "Escuela Mitre, Salta 45, quince alumnos" }]);
    assert.equal(
      efectoDe(s.efectos, "crear_solicitud_programa")!.datos.cantidadAlumnos,
      15,
    );
  });

  it("descarta cantidades de alumnos imposibles", () => {
    const s = simular(flujoProgramaEduca, [{ texto: "Escuela Mitre, Salta 45, 9000 alumnos" }]);
    assert.equal(
      efectoDe(s.efectos, "crear_solicitud_programa")!.datos.cantidadAlumnos,
      null,
      "9000 alumnos no es una escuela, es un dato mal leído",
    );
  });
});

describe("TRANSFORMÁ · murales y carteles", () => {
  it("registra dirección y foto de relevamiento", () => {
    const s = simular(flujoProgramaTransforma, [{ texto: "Lavalle 500", imagen: "foto-t1" }]);
    const d = efectoDe(s.efectos, "crear_solicitud_programa")!.datos;
    assert.equal(d.programa, "transforma");
    assert.equal(d.direccion, "Lavalle 500");
    assert.equal(efectoDe(s.efectos, "guardar_media")?.referencia, "foto-t1");
    // La solicitud lleva la referencia: sin esto el worker subía el archivo y
    // el update de photo_url no encontraba la fila (foto huérfana en el bucket).
    assert.equal(d.fotoReferencia, "foto-t1");
  });

  it("sin foto la solicitud sale con fotoReferencia null", () => {
    const s = simular(flujoProgramaTransforma, [{ texto: "Lavalle 500" }]);
    assert.equal(efectoDe(s.efectos, "crear_solicitud_programa")!.datos.fotoReferencia, null);
  });

  it("sin foto registra igual, pero la pide para después", () => {
    // La foto sirve al relevamiento, no a la validación. Bloquear el pedido por
    // una foto que el equipo puede sacar en la visita sería trabar de gusto.
    const s = simular(flujoProgramaTransforma, [{ texto: "Lavalle 500" }]);
    assert.ok(efectoDe(s.efectos, "crear_solicitud_programa"), "la solicitud se crea");
    assert.equal(efectoDe(s.efectos, "guardar_media"), undefined);
    assert.ok(dijo(s.dichos, "foto de la zona"), "la pide sin bloquear");
  });

  it("foto primero y dirección después no pierde la foto", () => {
    const s = simular(flujoProgramaTransforma, [{ imagen: "foto-t2" }, { texto: "Salta 45" }]);
    assert.equal(efectoDe(s.efectos, "guardar_media")?.referencia, "foto-t2");
    assert.ok(dijo(s.dichos, "Recibí la foto"));
  });
});

describe("SEPARÁ · la información va primero", () => {
  it("da los días y horarios ANTES de preguntar nada", () => {
    // Es la crítica central del QA: «yo mandaría primero la respuesta y si le
    // quedan dudas seguir». El vecino que sólo quería el horario ya lo tiene.
    const s = simular(flujoProgramaSepara, []);
    assert.match(s.dichos[0]!, /Miércoles y Sábados/);
    assert.match(s.dichos[0]!, /09 a 12/);
    assert.match(s.dichos[1]!, /\?/, "la pregunta viene después de la información");
  });

  it("dentro de las 4 avenidas: cierra sin pedir datos", () => {
    const s = simular(flujoProgramaSepara, [{ seleccion: "dentro" }]);
    assert.equal(s.estado, null);
    assert.equal(
      efectoDe(s.efectos, "crear_solicitud_programa"),
      undefined,
      "el recorrido ya lo cubre: no hay nada que coordinar",
    );
    assert.ok(dijo(s.dichos, "pasa por tu casa"));
  });

  it("acepta la respuesta escrita, no sólo el botón", () => {
    assert.equal(simular(flujoProgramaSepara, [{ texto: "si, dentro" }]).estado, null);
    assert.equal(simular(flujoProgramaSepara, [{ texto: "no, estoy afuera" }]).estado?.paso, "datos_fuera");
  });

  it("«no estoy seguro» toma el camino seguro en vez de insistir", () => {
    // El vecino no tiene por qué saber dónde termina un límite administrativo.
    // Insistir con la pregunta lo culpa de no saber algo que no le compete.
    const s = simular(flujoProgramaSepara, [{ seleccion: "no_se" }]);
    assert.equal(s.estado?.paso, "datos_fuera");
    assert.ok(dijo(s.dichos, "No hay problema"));
  });

  it("fuera de las avenidas pide los datos que el área definió", () => {
    const s = simular(flujoProgramaSepara, [{ seleccion: "fuera" }]);
    const pedido = s.dichos.at(-1)!;
    // Los cinco datos que el documento de QA enumera explícitamente.
    for (const dato of ["nombre", "teléfono", "dirección", "materiales", "franja"]) {
      assert.ok(pedido.toLowerCase().includes(dato), `falta pedir: ${dato}`);
    }
    assert.equal((pedido.match(/\?/g) ?? []).length, 0, "es un pedido, no un interrogatorio");
  });

  it("registra la solicitud con teléfono, franja y foto", () => {
    const s = simular(flujoProgramaSepara, [
      { seleccion: "fuera" },
      {
        texto: "Soy Ana Gomez, tel 381 4440012, Bolivar 350, tengo carton y plastico, de 9 a 12 hs",
        imagen: "foto-s1",
      },
    ]);
    const d = efectoDe(s.efectos, "crear_solicitud_programa")!.datos;
    assert.equal(d.programa, "separa");
    assert.equal(d.direccion, "Bolivar 350");
    assert.equal(d.telefonoContacto, "381 4440012");
    assert.match(d.informacionAdicional ?? "", /Franja: de 9 a 12 hs/);
    assert.match(d.informacionAdicional ?? "", /carton y plastico/, "los materiales se conservan");
    assert.equal(efectoDe(s.efectos, "guardar_media")?.referencia, "foto-s1");
    assert.equal(d.fotoReferencia, "foto-s1", "la solicitud lleva la referencia de la foto");
  });

  it("reconoce franjas descritas con palabras", () => {
    const s = simular(flujoProgramaSepara, [
      { seleccion: "fuera" },
      { texto: "Ana, Bolivar 350, estoy por la tarde" },
    ]);
    assert.match(
      efectoDe(s.efectos, "crear_solicitud_programa")!.datos.informacionAdicional ?? "",
      /por la tarde/,
    );
  });

  it("sin dirección no registra nada", () => {
    const s = simular(flujoProgramaSepara, [
      { seleccion: "fuera" },
      { texto: "Soy Ana y tengo carton" },
    ]);
    assert.equal(s.estado?.paso, "datos_fuera");
    assert.equal(efectoDe(s.efectos, "crear_solicitud_programa"), undefined);
  });
});

describe("EDUCÁ · el responsable, que se pedía y no se leía", () => {
  it("REGRESIÓN · ya no sale en null", () => {
    // `educa_requisitos` pide el responsable desde la migración 008 y no existía
    // nada que lo leyera: el 100% de las solicitudes quedaban con el literal
    // «No especificado» del default, indistinguible de «el vecino no lo dijo».
    const s = simular(flujoProgramaEduca, [
      {
        texto:
          "Escuela Normal Juan B Alberdi, Muñecas 200, responsable Ramiro Sosa, 30 alumnos, tel 3814440055",
      },
    ]);
    assert.equal(efectoDe(s.efectos, "crear_solicitud_programa")!.datos.responsable, "Ramiro Sosa");
  });

  it("acepta las formas en que se nombra a alguien en una escuela", () => {
    const casos: [string, string][] = [
      ["Escuela Belgrano, Muñecas 200, la directora es Marcela Paz", "Marcela Paz"],
      ["Escuela Belgrano, Muñecas 200, a cargo la seño Marta", "seño Marta"],
      ["Escuela Belgrano, Muñecas 200, referente: Ana Gómez", "Ana Gómez"],
    ];
    for (const [texto, esperado] of casos) {
      const s = simular(flujoProgramaEduca, [{ texto }]);
      assert.equal(
        efectoDe(s.efectos, "crear_solicitud_programa")!.datos.responsable,
        esperado,
        texto,
      );
    }
  });

  it("ante la duda deja el campo vacío en vez de inventar una persona", () => {
    // Esa columna es con la que el área llama por teléfono. Un fragmento de
    // oración ahí es peor que la columna vacía.
    const casos = [
      "Escuela Belgrano, Muñecas 200, el responsable de la limpieza pidió el taller",
      "Escuela Belgrano, Muñecas 200, el responsable todavia no lo definimos",
      "Escuela Belgrano, Muñecas 200, 30 alumnos",
    ];
    for (const texto of casos) {
      const s = simular(flujoProgramaEduca, [{ texto }]);
      assert.equal(
        efectoDe(s.efectos, "crear_solicitud_programa")!.datos.responsable,
        null,
        texto,
      );
    }
  });

  it("el nombre termina donde empieza el dato siguiente", () => {
    // Sin comas, que es como escribe la gente. «responsable Ana y 30 chicos» no
    // puede dar «Ana y».
    const s = simular(flujoProgramaEduca, [
      { texto: "Escuela Belgrano, Muñecas 200, responsable Ana y 30 chicos" },
    ]);
    assert.equal(efectoDe(s.efectos, "crear_solicitud_programa")!.datos.responsable, "Ana");
  });
});
