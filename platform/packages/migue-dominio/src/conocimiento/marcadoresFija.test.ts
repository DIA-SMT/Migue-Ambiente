/**
 * Los marcadores de una respuesta fija.
 *
 * Existen para que un dato operativo viva en UN solo lugar. Las tres
 * direcciones de los Puntos Verdes están en la tabla `puntos_verdes`, editable
 * desde Reglas; sin esto, quien escribiera la respuesta tendría que copiarlas
 * adentro del texto y mantenerlas sincronizadas a mano.
 *
 * No es hipotético: el bot ya contestó las direcciones sacándolas de un PDF de
 * pruebas en vez de la tabla, y con un cuarto Punto Verde cargado habría seguido
 * diciendo los tres viejos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { catalogoPrueba } from "../flujos/_fixtures.ts";
import { valoresDeRespuestaFija } from "../datos/catalogo.ts";
import { MARCADORES_DE_RESPUESTA_FIJA, marcadoresQueNoResuelveUnaFija } from "../marcadores.ts";
import { interpolar } from "../texto.ts";

describe("valoresDeRespuestaFija", () => {
  it("resuelve los Puntos Verdes desde la tabla, no desde un texto copiado", () => {
    const texto = interpolar(
      "Podés llevarlos a estos Puntos Verdes:\n{puntos_verdes}",
      valoresDeRespuestaFija(catalogoPrueba()),
    );
    assert.ok(texto.includes("Lamadrid 3700"), texto);
    assert.ok(texto.includes("Viamonte e Italia"), texto);
    assert.ok(!texto.includes("{puntos_verdes}"), "quedó el marcador sin resolver");
  });

  it("un Punto Verde nuevo aparece solo, sin tocar el texto de la respuesta", () => {
    // Es la razón de ser de todo esto. El texto es el mismo de la prueba
    // anterior; lo único que cambia es la tabla.
    const catalogo = catalogoPrueba({
      puntosVerdes: [
        {
          id: "9",
          nombre: "PV Nuevo",
          direccion: "Avenida Siempre Viva 742",
          tipo: "contenedor",
          horario: "8 a 20 hs",
          materiales: ["reciclables"],
          observaciones: null,
          orden: 5,
        },
      ],
    });
    const texto = interpolar("{puntos_verdes}", valoresDeRespuestaFija(catalogo));
    assert.ok(texto.includes("Avenida Siempre Viva 742"), texto);
  });

  it("sin Puntos Verdes cargados lo dice, en vez de dejar un hueco", () => {
    const texto = interpolar("{puntos_verdes}", valoresDeRespuestaFija(catalogoPrueba({ puntosVerdes: [] })));
    assert.ok(texto.includes("No tengo Puntos Verdes cargados"), texto);
    assert.ok(!texto.includes("{"), "no puede quedar una llave suelta");
  });

  it("resuelve la empresa de recolección desde la configuración", () => {
    const texto = interpolar("Se encarga {empresa}.", valoresDeRespuestaFija(catalogoPrueba()));
    assert.ok(!texto.includes("{empresa}"), texto);
  });
});

describe("la lista de marcadores y los valores no se pueden desincronizar", () => {
  it("cada marcador declarado tiene su valor, y al revés", () => {
    // La prueba que sostiene todo el mecanismo. Declarar un marcador y olvidar
    // el valor le manda al vecino un texto con llaves; escribir el valor y
    // olvidar la declaración hace que el panel rechace un marcador que sí
    // funciona. Las dos fallas son silenciosas.
    const declarados = MARCADORES_DE_RESPUESTA_FIJA.map((m) => m.slice(1, -1)).sort();
    const resueltos = Object.keys(valoresDeRespuestaFija(catalogoPrueba())).sort();
    assert.deepEqual(declarados, resueltos);
  });
});

describe("marcadoresQueNoResuelveUnaFija", () => {
  it("acepta los que el bot sabe resolver", () => {
    assert.deepEqual(marcadoresQueNoResuelveUnaFija("Van a {puntos_verdes}, los junta {empresa}."), []);
  });

  it("rechaza los de los flujos, que una fija no puede resolver", () => {
    // `{plazo}` es una fecha calculada contra el momento del pedido. Una fija no
    // tiene pedido del cual calcularla, así que aceptarla seria prometer algo
    // que no se cumple.
    assert.deepEqual(marcadoresQueNoResuelveUnaFija("Te contesto en {plazo}."), ["{plazo}"]);
    assert.deepEqual(marcadoresQueNoResuelveUnaFija("En {direccion} y {vencimiento}."), [
      "{direccion}",
      "{vencimiento}",
    ]);
  });

  it("no repite el mismo marcador dos veces en el mensaje de error", () => {
    assert.deepEqual(marcadoresQueNoResuelveUnaFija("{plazo} y otra vez {plazo}"), ["{plazo}"]);
  });

  it("un texto sin llaves no tiene nada que rechazar", () => {
    assert.deepEqual(marcadoresQueNoResuelveUnaFija("Los Puntos Verdes están en el centro."), []);
  });
});
