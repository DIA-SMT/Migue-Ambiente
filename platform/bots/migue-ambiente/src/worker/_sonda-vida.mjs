/**
 * Sonda de vida del bucle, para el test de regresión.
 *
 * Arranca el bucle con una cola SIEMPRE VACÍA y no hace nada más. Si el proceso
 * sigue vivo, el bucle mantiene el bucle de eventos de Node ocupado como debe.
 * Si se muere solo, estamos ante el bug de `unref()`: el worker salía con
 * código 0 en cuanto la cola quedaba vacía, PM2 lo reiniciaba, y en los logs no
 * aparecía ningún error.
 *
 * Tiene que ser un proceso aparte a propósito. Dentro de `node --test` el
 * runner mantiene vivo el bucle de eventos por su cuenta, así que un
 * temporizador sin referencia igual dispara y el bug no se ve.
 *
 * Imprime «vivo» cada vez que consulta la cola, para que el test lo pueda
 * observar. No requiere ni Supabase ni credenciales.
 */
import { crearBucle } from "./bucle.ts";

const colaVacia = {
  async tomar() {
    process.stdout.write("vivo\n");
    return null;
  },
  async terminar() {
    return { estado: "listo", intentos: 0 };
  },
  async recuperarColgados() {
    return 0;
  },
};

const puertosInertes = {
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
    return 0;
  },
  registrar() {},
};

const bucle = crearBucle(colaVacia, puertosInertes, {
  worker: "sonda",
  esperaVacia: 100,
  // Bien lejos, para que el barrido de colgados no sea lo que mantiene vivo el
  // proceso y el test mida lo que cree medir.
  intervaloRecuperacion: 3_600_000,
});

await bucle.correr();
