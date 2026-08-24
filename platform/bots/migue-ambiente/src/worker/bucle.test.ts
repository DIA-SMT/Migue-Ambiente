import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PuertosIngesta, Trabajo } from "@migue/dominio/ingesta";
import { crearBucle, type Cola } from "./bucle.ts";

/** Trabajo de prueba. */
function trabajo(parcial: Partial<Trabajo> = {}): Trabajo {
  return {
    id: "t1",
    tipo: "reindexar_todo",
    payload: {},
    intentos: 1,
    maxIntentos: 3,
    ...parcial,
  };
}

interface ColaFalsa extends Cola {
  cerrados: { id: string; error: string | undefined; definitivo: boolean | undefined }[];
  esperas: number[];
  barridos: number;
}

/**
 * Cola en memoria con una lista de trabajos por entregar.
 *
 * El reloj y la espera también son falsos: el bucle recibe `dormir` y `ahora`
 * por parámetro justamente para que un test no tarde segundos reales ni dependa
 * del reloj de la máquina.
 */
function colaFalsa(pendientes: Trabajo[], fallarAlTomar = 0): ColaFalsa {
  const cola: ColaFalsa = {
    cerrados: [],
    esperas: [],
    barridos: 0,
    async tomar() {
      if (cola.barridos >= 0 && fallarAlTomar > 0 && cola.cerrados.length < fallarAlTomar) {
        throw new Error("la base no responde");
      }
      return pendientes.shift() ?? null;
    },
    async terminar(id, error, definitivo) {
      cola.cerrados.push({ id, error, definitivo });
      // Se devuelve un estado coherente con lo que haría `terminar_trabajo`.
      const estado = error === undefined ? "listo" : definitivo ? "error" : "pendiente";
      return { estado, intentos: 1 };
    },
    async recuperarColgados() {
      cola.barridos++;
      return 0;
    },
  };
  return cola;
}

/** Puertos que siempre responden bien; lo que se prueba acá es el bucle. */
function puertosFalsos(sobre: Partial<PuertosIngesta> = {}): PuertosIngesta {
  return {
    async leerDocumento() {
      return null;
    },
    async marcarProcesando() {},
    async marcarError() {},
    async descargar() {
      return null;
    },
    async reemplazarFragmentos() {
      return 0;
    },
    async borrarDocumento() {},
    async encolarReindexado() {
      return 3;
    },
    registrar() {},
    ...sobre,
  };
}

/**
 * Corre el bucle con esperas falsas, deteniéndolo cuando la cola se vació.
 *
 * `dormir` es el punto donde el bucle se queda cuando no hay nada: se usa para
 * pedir el corte, que es lo mismo que pasa en producción cuando llega SIGTERM
 * con la cola vacía.
 */
async function correrHastaVaciar(cola: ColaFalsa, puertos = puertosFalsos()) {
  const registros: string[] = [];
  let bucle: ReturnType<typeof crearBucle>;

  bucle = crearBucle(cola, puertos, {
    worker: "prueba",
    esperaVacia: 50,
    intervaloRecuperacion: 1_000,
    // Un reloj plantado en 0 hacía que el intervalo nunca se cumpliera y el
    // test concluía que no había barrido. En producción `Date.now()` contra un
    // `ultimaRecuperacion` en 0 lo supera en la primera vuelta, que es
    // justamente lo que se busca: barrer al arrancar.
    ahora: () => 1_700_000_000_000,
    dormir: async (ms) => {
      cola.esperas.push(ms);
      // A la primera espera ya no hay trabajo: se corta.
      void bucle.detener();
    },
    registrar: (nivel, mensaje) => registros.push(`${nivel}: ${mensaje}`),
  });

  await bucle.correr();
  return { registros, estadisticas: bucle.estadisticas() };
}

describe("crearBucle", () => {
  it("procesa los trabajos de la cola y los cierra sin error", async () => {
    const cola = colaFalsa([trabajo({ id: "a" }), trabajo({ id: "b" })]);
    const { estadisticas } = await correrHastaVaciar(cola);

    assert.equal(estadisticas.procesados, 2);
    assert.equal(estadisticas.fallados, 0);
    assert.deepEqual(
      cola.cerrados.map((c) => c.id),
      ["a", "b"],
    );
    for (const cerrado of cola.cerrados) {
      assert.equal(cerrado.error, undefined, "cerró con error un trabajo que salió bien");
    }
  });

  it("espera cuando la cola está vacía en vez de consultar sin pausa", async () => {
    // Sin esta espera el worker consultaría Supabase miles de veces por minuto
    // para no hacer nada.
    const cola = colaFalsa([]);
    await correrHastaVaciar(cola);
    assert.deepEqual(cola.esperas, [50]);
  });

  it("un error definitivo se cierra como definitivo", async () => {
    // Es la diferencia que importa: el payload sin documento_id no mejora al
    // tercer intento, y si se reintentara volvería a la cola tapando a los que
    // sí pueden avanzar.
    const cola = colaFalsa([trabajo({ id: "malo", tipo: "ingestar_documento", payload: {} })]);
    const { estadisticas } = await correrHastaVaciar(cola);

    assert.equal(estadisticas.fallados, 1);
    assert.equal(cola.cerrados[0]?.definitivo, true, "no lo marcó definitivo");
    assert.match(cola.cerrados[0]?.error ?? "", /documento_id/);
  });

  it("un error de red se cierra como reintentable", async () => {
    const cola = colaFalsa([
      // El payload TIENE que traer el documento_id: sin él el trabajo falla por
      // payload inválido —que es definitivo— y el test no probaría la red.
      trabajo({ id: "red", tipo: "ingestar_documento", payload: { documento_id: "doc-1" } }),
    ]);
    const puertos = puertosFalsos({
      leerDocumento: async () => {
        throw new Error("fetch failed");
      },
    });
    await correrHastaVaciar(cola, puertos);

    assert.equal(cola.cerrados[0]?.definitivo, false, "marcó definitivo un fallo de red");
  });

  it("si la cola no responde, espera y sigue vivo", async () => {
    // Un corte de red de tres segundos no puede matar al worker: PM2 lo
    // reiniciaría en bucle mientras dure el corte.
    const cola = colaFalsa([], 1);
    const { registros, estadisticas } = await correrHastaVaciar(cola);

    assert.equal(estadisticas.procesados, 0);
    assert.ok(
      registros.some((r) => r.startsWith("error:") && r.includes("no pude consultar la cola")),
      registros.join(" | "),
    );
    assert.deepEqual(cola.esperas, [50], "no esperó antes de reintentar");
  });

  it("barre los trabajos colgados antes de tomar", async () => {
    // Si este worker es el único y murió en el intento anterior, el barrido es
    // lo que devuelve su trabajo a la cola.
    const cola = colaFalsa([]);
    await correrHastaVaciar(cola);
    assert.equal(cola.barridos, 1);
  });

  it("detener() resuelve recién cuando el bucle terminó de salir", async () => {
    // `onShutdown` espera a este handler antes de llamar a `process.exit`. Si
    // resolviera antes de tiempo, el proceso podría morir mientras se escriben
    // los fragmentos de un documento.
    //
    // Se comprueba contra la última línea que registra `correr()` antes de
    // avisar que salió. No sirve comprobar contra lo que pasa después de
    // `await bucle.correr()`: la promesa de `detener()` resuelve justo antes de
    // eso, así que esa versión del test no podía pasar nunca.
    const cola = colaFalsa([]);
    const registros: string[] = [];
    let resolvioAntesDeSalir: boolean | null = null;
    let bucle: ReturnType<typeof crearBucle>;

    bucle = crearBucle(cola, puertosFalsos(), {
      worker: "prueba",
      esperaVacia: 10,
      ahora: () => 1_700_000_000_000,
      registrar: (_nivel, mensaje) => registros.push(mensaje),
      dormir: async () => {
        await bucle.detener();
        resolvioAntesDeSalir = !registros.some((r) => r.includes("detenido"));
      },
    });

    await bucle.correr();

    assert.equal(resolvioAntesDeSalir, false, "detener() resolvió antes de que el bucle saliera");
    assert.ok(
      registros.some((r) => r.includes("detenido")),
      registros.join(" | "),
    );
  });

  it("detener() no se cuelga si el bucle ya había terminado", async () => {
    const cola = colaFalsa([]);
    const bucle = crearBucle(cola, puertosFalsos(), {
      worker: "prueba",
      esperaVacia: 10,
      ahora: () => 1_700_000_000_000,
      dormir: async () => {
        void bucleRef?.detener();
      },
    });
    const bucleRef: { detener(): unknown } | null = bucle;

    await bucle.correr();
    // Sin la guarda de «ya terminó», esto espera un aviso que nunca llega y el
    // cierre se cuelga hasta agotar el presupuesto de 2500 ms.
    await bucle.detener();
  });
});

describe("el proceso del worker sigue vivo con la cola vacía", () => {
  it("no se muere solo cuando no hay trabajo", async () => {
    // EL BUG: `esperar()` llamaba a `temporizador.unref()`. Un temporizador sin
    // referencia no mantiene vivo el bucle de eventos de Node, así que con la
    // cola vacía ese setTimeout era lo único pendiente, Node se quedaba sin
    // trabajo y el proceso salía con código 0. PM2 lo reiniciaba y quedaba en
    // bucle, sin un solo error en los logs.
    //
    // Se prueba en un proceso APARTE porque dentro de `node --test` el runner
    // mantiene vivo el bucle de eventos por su cuenta: el temporizador sin
    // referencia igual dispara y el bug se vuelve invisible.
    // `fileURLToPath` y no `.pathname`: la ruta de este proyecto tiene un acento
    // y un espacio, y `.pathname` los deja percent-encodeados
    // («Mat%C3%ADas%20Lujan»), así que Node no encuentra el archivo.
    const sonda = fileURLToPath(new URL("./_sonda-vida.mjs", import.meta.url));
    const hijo = spawn(process.execPath, [sonda], { stdio: ["ignore", "pipe", "pipe"] });

    let latidos = 0;
    let salida = "";
    hijo.stdout.on("data", (d: Buffer) => {
      latidos += d.toString().split("vivo").length - 1;
    });
    hijo.stderr.on("data", (d: Buffer) => {
      salida += d.toString();
    });

    const codigo = await new Promise<number | null>((resolver) => {
      let terminado = false;
      hijo.on("exit", (c) => {
        terminado = true;
        resolver(c);
      });
      // Con esperaVacia en 100 ms, en un segundo tiene que haber consultado la
      // cola varias veces y seguir vivo.
      setTimeout(() => {
        if (!terminado) {
          hijo.kill();
          resolver(null);
        }
      }, 1_200);
    });

    assert.equal(
      codigo,
      null,
      `el worker se murió solo (código ${codigo}) con la cola vacía. stderr: ${salida.slice(0, 300)}`,
    );
    assert.ok(latidos >= 3, `consultó la cola sólo ${latidos} veces en 1,2 s`);
  });
});
