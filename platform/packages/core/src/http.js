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
 *       "POST /webhook": async (req, res, body) => { ... },
 *     },
 *   });
 */
export async function startHttpServer({
  port,
  host = "127.0.0.1",
  routes = {},
  readiness,
  maxBodyBytes = 1024 * 1024,
} = {}) {
  if (!port) throw new Error("startHttpServer necesita un puerto");

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

      const body = await readBody(req, maxBodyBytes);
      await handler(req, res, body);
      if (!res.writableEnded) send(res, 200, { ok: true });
    } catch (err) {
      log.error({ err: err.message, route: key }, "handler HTTP falló");
      if (!res.writableEnded) send(res, 500, { error: "internal error" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  log.info({ host, port, routes: Object.keys(routes) }, "servidor HTTP arriba");

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

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") return resolve(null);

    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      // Cortar temprano: no queremos bufferear un payload gigante
      if (size > maxBytes) {
        req.destroy();
        return reject(new Error(`body mas grande que ${maxBytes} bytes`));
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      const type = req.headers["content-type"] || "";
      if (type.includes("application/json")) {
        try {
          return resolve(JSON.parse(raw));
        } catch {
          return reject(new Error("JSON invalido en el body"));
        }
      }
      resolve(raw);
    });

    req.on("error", reject);
  });
}
