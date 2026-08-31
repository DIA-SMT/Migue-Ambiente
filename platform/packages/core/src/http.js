import http from "node:http";
import { createLogger } from "./logger.js";
import { onShutdown } from "./shutdown.js";

const log = createLogger("http");

/**
 * Servidor HTTP minimo por bot, para dos cosas:
 *   - /healthz  (el proceso vive) y /readyz (las dependencias responden)
 *   - webhooks, si el bot usa webhook en vez de long polling
 *
 * Escucha solo en 127.0.0.1: nginx es el unico que entra desde afuera, asi
 * el puerto del bot nunca queda expuesto a internet.
 *
 *   const server = await startHttpServer({
 *     port: 3001,
 *     readiness: async () => await pingDb(),
 *     routes: {
 *       "POST /webhook": async (req, res, body, crudo) => { ... },
 *     },
 *   });
 *
 * El cuarto argumento del handler son los BYTES CRUDOS del cuerpo. Hacen falta
 * para los webhooks firmados —WhatsApp firma con HMAC sobre el cuerpo tal como
 * viajo— y `JSON.stringify(JSON.parse(x))` no devuelve los mismos bytes: un
 * espacio o un escape Unicode distinto y la firma no da.
 */
export async function startHttpServer({
  port,
  host = "127.0.0.1",
  routes = {},
  readiness,
  maxBodyBytes = 1024 * 1024,
} = {}) {
  // `== null` y no `!port`: el puerto 0 es valido y significa "el que haya
  // libre". Es el que usan las pruebas para no chocar con nada.
  if (port == null) throw new Error("startHttpServer necesita un puerto");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const key = `${req.method} ${url.pathname}`;

    try {
      if (key === "GET /healthz") return send(res, 200, { status: "ok" });

      if (key === "GET /readyz") {
        if (!readiness) return send(res, 200, { status: "ok" });
        const ready = await readiness();
        return send(res, ready ? 200 : 503, {
          status: ready ? "ok" : "not-ready",
        });
      }

      const handler = routes[key];
      if (!handler) return send(res, 404, { error: "not found" });

      const { body, crudo } = await readBody(req, maxBodyBytes);
      await handler(req, res, body, crudo);
      if (!res.writableEnded) send(res, 200, { ok: true });
    } catch (err) {
      // Un cuerpo mal formado es culpa de quien llama, no nuestra: devolver 500
      // hace que el que reintenta —Meta reintenta— insista contra algo que
      // nunca va a andar, y llena el log de errores que no son errores.
      const estado = Number.isInteger(err?.status) ? err.status : 500;
      const detalle = { err: err.message, route: key };
      if (estado >= 500) log.error(detalle, "handler HTTP falló");
      else log.warn(detalle, "pedido HTTP rechazado");
      if (!res.writableEnded) {
        send(res, estado, { error: estado >= 500 ? "internal error" : err.message });
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  // El puerto real y no el pedido: con `port: 0` el pedido es 0 y el real es el
  // que asigno el sistema, que es el unico que sirve para conectarse.
  const asignado = server.address()?.port ?? port;
  log.info({ host, port: asignado, routes: Object.keys(routes) }, "servidor HTTP arriba");

  onShutdown("http", () => {
    return new Promise((resolve) => {
      server.close(() => resolve());
      // No esperamos a que los keep-alive se venzan solos
      server.closeIdleConnections?.();
    });
  });

  return server;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Error con el codigo HTTP que le corresponde, para no contestar 500 a todo. */
function fallaDelCliente(mensaje, status) {
  const err = new Error(mensaje);
  err.status = status;
  return err;
}

/**
 * Junta el cuerpo y devuelve las DOS formas: los bytes tal como llegaron y el
 * valor ya interpretado. Los bytes son los que se firman; el valor es el que se
 * usa. Ver el comentario de `startHttpServer`.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const vacio = { body: null, crudo: Buffer.alloc(0) };
    if (req.method === "GET" || req.method === "HEAD") return resolve(vacio);

    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      // Cortar temprano: no queremos bufferear un payload gigante
      if (size > maxBytes) {
        req.destroy();
        return reject(fallaDelCliente(`body mas grande que ${maxBytes} bytes`, 413));
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const crudo = Buffer.concat(chunks);
      if (crudo.length === 0) return resolve(vacio);

      const texto = crudo.toString("utf8");
      const type = req.headers["content-type"] || "";
      if (type.includes("application/json")) {
        try {
          return resolve({ body: JSON.parse(texto), crudo });
        } catch {
          return reject(fallaDelCliente("JSON invalido en el body", 400));
        }
      }
      resolve({ body: texto, crudo });
    });

    req.on("error", reject);
  });
}
