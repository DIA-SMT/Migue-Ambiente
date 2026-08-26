/**
 * Los días de recolección, tal como los lee el vecino.
 *
 * La base los guarda sin acento porque es la forma con la que se compara y se
 * busca. Esa decisión es correcta adentro, pero se filtraba afuera: Migue
 * respondía «miercoles» y «sabado» en el texto que le llega a la persona.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { catalogoPrueba } from "../flujos/_fixtures.ts";
import { describirZonas, type ZonaRecoleccion } from "./catalogo.ts";

function zona(nombre: string, dias: string[], horaSacar: string | null = null): ZonaRecoleccion {
  return { id: nombre, nombre, dias, horaSacar, observaciones: null };
}

function describir(zonas: ZonaRecoleccion[]): string {
  return describirZonas(catalogoPrueba({ zonas }));
}

describe("describirZonas", () => {
  it("acentúa los días que la base guarda sin acento", () => {
    const texto = describir([zona("Centro", ["miercoles", "sabado"])]);
    assert.match(texto, /miércoles/);
    assert.match(texto, /sábado/);
    // Lo que importa es que el valor crudo no llegue a la respuesta.
    assert.doesNotMatch(texto, /miercoles|sabado/);
  });

  it("los deja en minúscula, porque caen en medio de la oración", () => {
    const texto = describir([zona("Centro", ["lunes", "miercoles"])]);
    assert.match(texto, /lunes/);
    assert.doesNotMatch(texto, /Lunes|Miércoles/);
  });

  it("un día que no esté en la tabla se muestra igual, no desaparece", () => {
    assert.match(describir([zona("Centro", ["feriados"])]), /feriados/);
  });

  it("mantiene el nombre de la zona y la hora de sacar", () => {
    const texto = describir([zona("Sur", ["lunes", "sabado"], "20 a 22")]);
    assert.match(texto, /Sur/);
    assert.match(texto, /lunes.+sábado/s);
    assert.match(texto, /sacar a las 20 a 22/);
  });

  it("sin zonas cargadas lo dice, en vez de devolver vacío", () => {
    assert.match(describir([]), /no tengo las zonas/i);
  });
});
