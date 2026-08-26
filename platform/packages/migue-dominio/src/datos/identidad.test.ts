/**
 * La identidad de Migue, y sus dos pisos de seguridad.
 *
 * El nombre del área y el estilo de redacción se editan desde Reglas. Eso
 * significa que alguien puede vaciarlos, y el bot tiene que seguir hablando
 * bien igual: una configuración a medias no puede dejar a Migue presentándose
 * como «el asistente de la  de la Municipalidad».
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { catalogoPrueba } from "../flujos/_fixtures.ts";
import { leerConfig, nombreDelArea } from "./catalogo.ts";

describe("nombreDelArea", () => {
  it("usa el que cargó el área", () => {
    const c = catalogoPrueba({
      configuracion: new Map([["nombre_area", "Secretaría de Ambiente y Espacios Verdes"]]),
    });
    assert.equal(nombreDelArea(c), "Secretaría de Ambiente y Espacios Verdes");
  });

  it("sin la clave cargada cae al nombre oficial, no a una cadena vacía", () => {
    // Es el caso real hasta que se aplique la 032. Y el que queda si alguien
    // borra la fila: Migue tiene que seguir presentándose con un área.
    const c = catalogoPrueba({ configuracion: new Map() });
    assert.equal(nombreDelArea(c), "Secretaría de Ambiente y Desarrollo Sustentable");
  });

  it("el nombre por defecto es el de los documentos del municipio", () => {
    // Los Planes Rectores dicen «Secretaría de Ambiente y Desarrollo
    // Sustentable» cuatro veces y «Dirección de Ambiente» ninguna. El código
    // decía la segunda: Migue se presentaba con un área que no existe así.
    const nombre = nombreDelArea(catalogoPrueba({ configuracion: new Map() }));
    assert.ok(nombre.startsWith("Secretaría"), nombre);
    assert.ok(!/Dirección/.test(nombre), nombre);
  });
});

describe("el estilo de redacción", () => {
  it("vaciarlo no deja al bot sin instrucciones de redacción", () => {
    // `responder.ts` hace `|| ESTILO_POR_DEFECTO` sobre el valor recortado. Se
    // verifica la condición acá porque un espacio en blanco guardado desde el
    // panel es indistinguible de vacío para una persona, y no para `||`.
    for (const guardado of ["", "   ", "\n\n"]) {
      const c = catalogoPrueba({ configuracion: new Map([["estilo_respuesta", guardado]]) });
      const leido = String(leerConfig(c, "estilo_respuesta", "")).trim();
      assert.equal(leido, "", `«${guardado}» tendría que quedar vacío tras recortar`);
    }
  });

  it("un estilo cargado se lee tal cual, con sus saltos de línea", () => {
    const estilo = "- Hablá de usted.\n- Máximo una frase.";
    const c = catalogoPrueba({ configuracion: new Map([["estilo_respuesta", estilo]]) });
    assert.equal(String(leerConfig(c, "estilo_respuesta", "")).trim(), estilo);
  });
});
