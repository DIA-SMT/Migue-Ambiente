/**
 * Que el atajo de saludos no se coma una consulta.
 *
 * POR QUÉ EXISTE
 *
 * `porAtajo` resuelve «hola» y «gracias» sin llamar al modelo. La guarda era
 * «como máximo 4 palabras», y no alcanzaba: estos tres mensajes se clasificaban
 * como saludo o despedida, verificado corriendo el clasificador real contra
 * producción antes del arreglo.
 *
 *   «hola necesito retirar escombros»  ->  saludo      (son exactamente 4)
 *   «hola pasa el sabado?»             ->  saludo
 *   «gracias donde reciclo vidrio»     ->  despedida
 *
 * El primero es literalmente el ejemplo que el comentario de la propia función
 * decía estar evitando. Al vecino del vidrio Migue le contestaba «¡De nada!» y le
 * CERRABA la conversación.
 *
 * Y lo peor: no quedaba registro en ninguna parte. El atajo corta antes del
 * modelo y antes de la búsqueda de conocimiento, que es la única que sabe
 * escribir en `sin_respuesta`. La falla era invisible por diseño — la pantalla de
 * Métricas podía mostrar «0 preguntas sin responder» mientras el bot despedía a
 * gente que había preguntado algo.
 *
 * La asimetría que gobierna esta prueba: una llamada al modelo de más cuesta una
 * fracción de centavo; una pregunta contestada con «¡De nada!» pierde a un
 * vecino. Ante la duda, no atajar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { porAtajo } from "./router.ts";

/** Sólo un saludo o una despedida: el atajo tiene que actuar. */
const SOLO_CORTESIA: readonly [string, "saludo" | "despedida"][] = [
  ["hola", "saludo"],
  ["Hola!", "saludo"],
  ["HOLA", "saludo"],
  ["buenas", "saludo"],
  ["buenas tardes", "saludo"],
  ["buen dia", "saludo"],
  ["holis", "saludo"],
  ["que tal", "saludo"],
  ["gracias", "despedida"],
  ["Gracias!", "despedida"],
  ["muchas gracias", "despedida"],
  ["listo gracias", "despedida"],
  ["ok gracias", "despedida"],
  ["dale gracias", "despedida"],
  ["perfecto gracias", "despedida"],
  ["muy amable", "despedida"],
  ["chau", "despedida"],
  ["nos vemos", "despedida"],
  ["hasta luego", "despedida"],
];

/**
 * Trae un saludo Y una consulta. El atajo NO tiene que actuar.
 *
 * Los tres primeros son los casos reales que se comía.
 */
const CORTESIA_MAS_CONSULTA: readonly string[] = [
  "gracias donde reciclo vidrio",
  "hola pasa el sabado?",
  "hola necesito retirar escombros",
  "buenas el camion no paso",
  "che gracias y el vidrio?",
  "hola, donde hay un punto verde",
  "chau pero antes decime el horario",
  "buenas tardes, cuando pasan por mi barrio",
  "hola quiero hacer un reclamo",
  "gracias, y los neumaticos donde van?",
];

describe("el atajo de cortesía", () => {
  for (const [texto, esperado] of SOLO_CORTESIA) {
    it(`«${texto}» es ${esperado}`, () => {
      assert.equal(
        porAtajo(texto),
        esperado,
        "un saludo solo tiene que resolverse sin pagar una llamada al modelo",
      );
    });
  }
});

describe("un saludo con una consulta atrás NO es un saludo", () => {
  for (const texto of CORTESIA_MAS_CONSULTA) {
    it(`«${texto}» sigue al clasificador`, () => {
      // `null` significa «que lo vea el modelo». Qué intención le ponga después
      // es asunto del modelo; lo que esta prueba defiende es que el mensaje
      // llegue a tener la chance.
      assert.equal(
        porAtajo(texto),
        null,
        `se resolvió por atajo: el vecino preguntó algo y no lo va a recibir`,
      );
    });
  }
});

describe("los límites del atajo", () => {
  it("un mensaje largo no es un saludo por empezar con «hola»", () => {
    assert.equal(
      porAtajo(
        "hola buenas tardes queria consultar por el retiro de unos escombros que tengo en la vereda",
      ),
      null,
    );
  });

  it("el texto vacío no se resuelve por atajo", () => {
    assert.equal(porAtajo("   "), null);
    assert.equal(porAtajo(""), null);
  });

  // «listo gracias» tiene que ganarle a «gracias»: si coincidiera primero el
  // término corto, sobraría «listo» y el atajo se saltearía por nada.
  it("el término más largo gana, así no sobra relleno", () => {
    for (const texto of ["listo gracias", "ok gracias", "muchas gracias", "perfecto gracias"]) {
      assert.equal(porAtajo(texto), "despedida", `«${texto}» tendría que cortar por atajo`);
    }
  });

  // Una despedida gana a un saludo cuando están las dos: «hola gracias» es
  // alguien cerrando, no abriendo. Es el orden que ya tenía la función.
  it("la despedida gana cuando hay las dos", () => {
    assert.equal(porAtajo("hola gracias"), "despedida");
  });

  //  es el primer mensaje de todo vecino nuevo de Telegram: lo manda el
  // botón «Empezar». No estaba manejado, así que el primer contacto de cada
  // persona era «no entendí, elegí una opción» — y pagaba una llamada al modelo
  // para no entender un comando fijo.
  it("/start es un saludo y no gasta una llamada al modelo", () => {
    assert.equal(porAtajo("/start"), "saludo");
    assert.equal(porAtajo("/START"), "saludo");
    assert.equal(porAtajo("/start@MigueAmbienteBot"), "saludo");
  });

  // Otros comandos NO se atajan: son raros y no hay que tragárselos en silencio.
  it("los demás comandos siguen al clasificador", () => {
    assert.equal(porAtajo("/help"), null);
    assert.equal(porAtajo("/reclamo"), null);
  });
});

describe("pedido de asesor por atajo", () => {
  it("las frases directas se resuelven sin modelo", () => {
    for (const frase of [
      "asesor",
      "quiero hablar con una persona",
      "necesito un asesor",
      "me atiende un humano",
      "que me llame alguien",
    ]) {
      assert.equal(porAtajo(frase), "pedir_asesor", `«${frase}»`);
    }
  });

  it("la cortesía alrededor no lo tapa", () => {
    assert.equal(porAtajo("hola, quiero hablar con una persona"), "pedir_asesor");
    assert.equal(porAtajo("gracias, quiero hablar con alguien"), "pedir_asesor");
  });

  it("mencionar a una persona NO es pedirla: eso lo decide el modelo", () => {
    // «el operador me dijo...» habla DE un operador; el atajo compara la frase
    // exacta tras quitar cortesía, así que esto va al clasificador.
    assert.equal(porAtajo("el operador me dijo que saque la basura"), null);
    assert.equal(porAtajo("necesito un asesor para retirar escombros"), null);
  });

  it("los saludos y despedidas siguen funcionando igual tras el refactor", () => {
    assert.equal(porAtajo("hola"), "saludo");
    assert.equal(porAtajo("listo gracias"), "despedida");
  });
});
