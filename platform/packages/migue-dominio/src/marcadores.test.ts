/**
 * Que ningún vecino reciba un `{marcador}` con las llaves puestas.
 *
 * La prueba central de este archivo NO compara contra `MARCADORES_POR_TEXTO`:
 * eso sería confirmar mi propia suposición, que es el error que en este proyecto
 * ya dejó pasar un bug —un test que comparaba los ids del menú contra una lista
 * escrita en el propio test—. En cambio simula los flujos completos y verifica
 * que ningún mensaje SALIENTE conserve algo entre llaves.
 *
 * Así, si mañana alguien agrega un paso que escribe `{barrio}` en un texto y se
 * olvida de interpolarlo, esta prueba falla sola.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  marcadoresDe,
  marcadoresQueNoSeResuelven,
  MARCADORES_POR_TEXTO,
} from "./marcadores.ts";
import { catalogoPrueba, simular } from "./flujos/_fixtures.ts";
import { flujoRetiroNoHabitual } from "./flujos/retiroNoHabitual.ts";
import { flujoReclamoRecoleccion } from "./flujos/reclamoRecoleccion.ts";

/** Cualquier cosa entre llaves que haya quedado sin reemplazar. */
const SIN_RESOLVER = /\{[a-zA-Z_]+\}/g;

describe("ningún mensaje del bot sale con un marcador sin resolver", () => {
  it("el flujo de retiro no habitual", () => {
    const { dichos } = simular(flujoRetiroNoHabitual, [
      { texto: "escombros" },
      { imagen: "foto-1" },
      { texto: "Lamadrid 550" },
    ]);

    for (const dicho of dichos) {
      const restos = dicho.match(SIN_RESOLVER);
      assert.equal(
        restos,
        null,
        `este mensaje le llegaría al vecino con las llaves puestas: ${JSON.stringify(dicho)}`,
      );
    }
  });

  it("el flujo de reclamo por recolección", () => {
    const { dichos } = simular(flujoReclamoRecoleccion, [
      { texto: "no pasó el camión" },
      { texto: "Lamadrid 550" },
      { texto: "3 días" },
    ]);

    for (const dicho of dichos) {
      assert.equal(
        dicho.match(SIN_RESOLVER),
        null,
        `este mensaje le llegaría al vecino con las llaves puestas: ${JSON.stringify(dicho)}`,
      );
    }
  });

  // Al revés: las claves que NO están en el mapa no tienen que traer marcadores
  // escritos, porque nadie los va a reemplazar. Se comprueba contra el fixture,
  // que espeja producción.
  it("ninguna clave sin interpolación tiene marcadores escritos", () => {
    for (const [clave, texto] of catalogoPrueba().textos) {
      if (marcadoresDe(clave).length > 0) continue;
      assert.equal(
        texto.match(SIN_RESOLVER),
        null,
        `«${clave}» tiene marcadores y nadie los reemplaza: se enviarían con las llaves`,
      );
    }
  });
});

describe("marcadoresQueNoSeResuelven", () => {
  it("acepta los cuatro en un texto de confirmación", () => {
    assert.deepEqual(
      marcadoresQueNoSeResuelven(
        "retiro_confirmacion",
        "Listo. {empresa} lo retira en {plazo}, antes del {vencimiento}, en {direccion}.",
      ),
      [],
    );
  });

  // El caso que motivó todo esto. La validación vieja miraba si el NOMBRE del
  // marcador era real, no si la clave llegaba a interpolarse — así que esto
  // pasaba, y el vecino recibía «te contesto en {plazo}».
  it("rechaza un marcador real en una clave que no interpola", () => {
    assert.deepEqual(
      marcadoresQueNoSeResuelven("bienvenida", "Hola, te contesto en {plazo}."),
      ["{plazo}"],
    );
  });

  it("rechaza un marcador mal escrito incluso donde sí se interpola", () => {
    assert.deepEqual(
      marcadoresQueNoSeResuelven("retiro_confirmacion", "Lo retiran en {palzo}."),
      ["{palzo}"],
    );
  });

  it("no repite el mismo marcador dos veces en el mensaje de error", () => {
    assert.deepEqual(
      marcadoresQueNoSeResuelven("despedida", "{plazo} y {plazo} y {empresa}"),
      ["{plazo}", "{empresa}"],
    );
  });

  it("un texto sin llaves nunca da problemas", () => {
    assert.deepEqual(marcadoresQueNoSeResuelven("bienvenida", "Hola, soy Migue."), []);
    assert.deepEqual(marcadoresQueNoSeResuelven("clave_que_no_existe", "hola"), []);
  });
});

describe("MARCADORES_POR_TEXTO", () => {
  // Si alguien agrega una clave al mapa, tiene que ser una clave real. Una
  // entrada con un typo haría que el panel acepte marcadores en una clave que
  // no interpola, que es exactamente el bug que este archivo viene a cerrar.
  it("todas sus claves existen en el catálogo", () => {
    const delCatalogo = new Set(catalogoPrueba().textos.keys());
    for (const clave of Object.keys(MARCADORES_POR_TEXTO)) {
      assert.ok(delCatalogo.has(clave), `«${clave}» no es una clave de textos_bot`);
    }
  });
});
