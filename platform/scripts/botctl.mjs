#!/usr/bin/env node
/**
 * botctl — alta y diagnostico de bots en el registro.
 *
 *   node scripts/botctl.mjs list
 *   node scripts/botctl.mjs new <nombre> [--port 3001] [--webhook]
 *   node scripts/botctl.mjs doctor
 *
 * Solo usa modulos nativos de Node, asi corre incluso antes del pnpm install.
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = path.join(ROOT, "bots.json");
const BOTS_DIR = path.join(ROOT, "bots");
const TEMPLATE = path.join(BOTS_DIR, "_template");

const C = {
  off: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const ok = (m) => console.log(`${C.green}  ok${C.off} ${m}`);
const bad = (m) => console.log(`${C.red}  ✗ ${C.off} ${m}`);
const warn = (m) => console.log(`${C.yellow}  ! ${C.off} ${m}`);
const head = (m) => console.log(`\n${C.cyan}==>${C.off} ${m}`);

function die(msg) {
  console.error(`${C.red}error:${C.off} ${msg}`);
  process.exit(1);
}

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch (err) {
    die(`no pude leer bots.json: ${err.message}`);
  }
}

function writeRegistry(data) {
  fs.writeFileSync(REGISTRY, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Copia recursiva. Hecha a mano en vez de con fs.cpSync porque cpSync tira
 * EIO en algunos Windows, y el mismo script se usa desde la maquina local.
 */
function copiarDir(origen, destino) {
  fs.mkdirSync(destino, { recursive: true });
  for (const entrada of fs.readdirSync(origen, { withFileTypes: true })) {
    const desde = path.join(origen, entrada.name);
    const hacia = path.join(destino, entrada.name);
    if (entrada.isDirectory()) {
      copiarDir(desde, hacia);
    } else if (entrada.isFile()) {
      fs.copyFileSync(desde, hacia);
    }
    // symlinks y demas se ignoran a proposito: la plantilla no deberia tenerlos
  }
}

// --------------------------------- list ------------------------------------
function cmdList() {
  const { bots } = readRegistry();
  if (bots.length === 0) return console.log("No hay bots registrados.");

  let pm2 = {};
  try {
    const raw = execFileSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const proc of JSON.parse(raw)) {
      pm2[proc.name] = {
        status: proc.pm2_env?.status ?? "?",
        restarts: proc.pm2_env?.restart_time ?? 0,
        mem: proc.monit?.memory ? `${Math.round(proc.monit.memory / 1048576)}M` : "-",
        cpu: proc.monit?.cpu != null ? `${proc.monit.cpu}%` : "-",
      };
    }
  } catch {
    warn("pm2 no responde — muestro solo el registro");
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `\n${C.dim}${pad("BOT", 18)}${pad("HABIL.", 8)}${pad("PUERTO", 8)}` +
      `${pad("ESTADO", 12)}${pad("REINIC.", 9)}${pad("MEM", 7)}CPU${C.off}`,
  );
  for (const bot of bots) {
    const p = pm2[bot.name] || {};
    const estado = p.status
      ? p.status === "online" ? `${C.green}online${C.off}` : `${C.red}${p.status}${C.off}`
      : `${C.dim}-${C.off}`;
    console.log(
      pad(bot.name, 18) +
        pad(bot.enabled === false ? "no" : "sí", 8) +
        pad(bot.port ?? "-", 8) +
        pad(estado, 12 + (p.status ? 9 : 8)) +
        pad(p.restarts ?? "-", 9) +
        pad(p.mem ?? "-", 7) +
        (p.cpu ?? "-"),
    );
  }
  console.log();
}

// ---------------------------------- new ------------------------------------
function cmdNew(argv) {
  const nombre = argv[0];
  if (!nombre) die("uso: botctl new <nombre> [--port 3001] [--webhook]");
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(nombre)) {
    die("el nombre debe ser minusculas, numeros y guiones, empezando con letra");
  }

  const registry = readRegistry();
  if (registry.bots.some((b) => b.name === nombre)) {
    die(`ya existe un bot llamado "${nombre}" en bots.json`);
  }

  const destino = path.join(BOTS_DIR, nombre);
  if (fs.existsSync(destino)) die(`la carpeta ${destino} ya existe`);
  if (!fs.existsSync(TEMPLATE)) die(`no encuentro la plantilla en ${TEMPLATE}`);

  // Puerto: explicito, o el primero libre arriba de 3000 que no este tomado
  const usaWebhook = argv.includes("--webhook");
  const portFlag = argv.indexOf("--port");
  let port = null;
  if (portFlag !== -1) {
    port = Number(argv[portFlag + 1]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      die("--port necesita un entero entre 1024 y 65535");
    }
  } else if (usaWebhook) {
    const usados = new Set(registry.bots.map((b) => b.port).filter(Boolean));
    port = 3001;
    while (usados.has(port)) port += 1;
  }

  copiarDir(TEMPLATE, destino);

  // package.json propio
  const pkgPath = path.join(destino, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.name = `@bots/${nombre}`;
  pkg.description = `Bot ${nombre}`;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // .env a partir del ejemplo, para que arranque sin editar nada mas que el token
  const ejemplo = path.join(destino, ".env.example");
  const env = path.join(destino, ".env");
  if (fs.existsSync(ejemplo) && !fs.existsSync(env)) {
    let contenido = fs.readFileSync(ejemplo, "utf8");
    if (usaWebhook) contenido = contenido.replace("USE_WEBHOOK=false", "USE_WEBHOOK=true");
    fs.writeFileSync(env, contenido, { mode: 0o600 });
  }

  registry.bots.push({
    name: nombre,
    dir: nombre,
    entry: "src/index.js",
    enabled: true,
    instances: 1,
    port,
    maxMemory: "400M",
    env: {},
  });
  writeRegistry(registry);

  head(`Bot "${nombre}" creado`);
  ok(`carpeta   bots/${nombre}/`);
  ok(`registro  bots.json actualizado${port ? ` (puerto ${port})` : ""}`);
  console.log(`
Siguientes pasos:
  1. completar el token       ${C.dim}bots/${nombre}/.env${C.off}
  2. instalar dependencias    ${C.dim}pnpm install${C.off}
  3. arrancarlo               ${C.dim}pm2 start ecosystem.config.cjs --only ${nombre}${C.off}
  4. persistir el estado      ${C.dim}pm2 save${C.off}`);
  if (port) {
    console.log(`  5. exponer el webhook       ${C.dim}/etc/nginx/bots.d/${nombre}.conf${C.off}
     location /hooks/${nombre}/ { proxy_pass http://127.0.0.1:${port}/; }`);
  }
  console.log();
}

// ----------------------------------- rm ------------------------------------
function cmdRm(argv) {
  const nombre = argv[0];
  if (!nombre) die("uso: botctl rm <nombre> [--purge]");

  const registry = readRegistry();
  const indice = registry.bots.findIndex((b) => b.name === nombre);
  if (indice === -1) die(`no hay ningun bot llamado "${nombre}" en bots.json`);
  if (registry.bots[indice].dir === "_template") die("no se puede borrar la plantilla");

  // Bajarlo de PM2 antes de tocar archivos, si no queda un proceso huerfano
  // apuntando a una carpeta que ya no existe.
  try {
    execFileSync("pm2", ["delete", nombre], { stdio: "ignore" });
    ok(`detenido y quitado de PM2`);
  } catch {
    warn("PM2 no lo tenia corriendo (o no responde)");
  }

  const dir = path.join(BOTS_DIR, registry.bots[indice].dir);
  registry.bots.splice(indice, 1);
  writeRegistry(registry);
  ok("quitado de bots.json");

  if (argv.includes("--purge")) {
    // El .env se va con la carpeta: son credenciales, no las dejamos sueltas
    fs.rmSync(dir, { recursive: true, force: true });
    ok(`carpeta borrada  bots/${path.basename(dir)}/`);
  } else {
    warn(`la carpeta bots/${path.basename(dir)}/ quedó en disco`);
    console.log(`     ${C.dim}usá --purge para borrarla tambien (incluye el .env)${C.off}`);
  }

  console.log(`\n  ${C.dim}acordate de: pm2 save${C.off}\n`);
}

// -------------------------------- doctor -----------------------------------
async function cmdDoctor() {
  let fallas = 0;
  const problema = (m) => { bad(m); fallas += 1; };

  head("Entorno");
  const major = Number(process.versions.node.split(".")[0]);
  major >= 22
    ? ok(`Node ${process.version}`)
    : problema(`Node ${process.version} — se esperaba >= 22`);

  for (const bin of ["pnpm", "pm2"]) {
    try {
      const v = execFileSync(bin, ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      ok(`${bin} ${v}`);
    } catch {
      problema(`${bin} no está instalado o no está en el PATH`);
    }
  }

  head("Registro de bots");
  const { bots } = readRegistry();
  const nombres = new Set();
  const puertos = new Map();

  for (const bot of bots) {
    const etiqueta = bot.name || "(sin nombre)";

    if (nombres.has(bot.name)) problema(`${etiqueta}: nombre duplicado`);
    nombres.add(bot.name);

    const dir = path.join(BOTS_DIR, bot.dir ?? "");
    if (!fs.existsSync(path.join(dir, bot.entry ?? ""))) {
      problema(`${etiqueta}: no existe el entry ${bot.dir}/${bot.entry}`);
      continue;
    }

    if (bot.enabled !== false && !fs.existsSync(path.join(dir, ".env"))) {
      problema(`${etiqueta}: habilitado pero sin .env`);
    }

    if (bot.port) {
      if (puertos.has(bot.port)) {
        problema(`${etiqueta}: puerto ${bot.port} ya usado por ${puertos.get(bot.port)}`);
      }
      puertos.set(bot.port, etiqueta);
    }

    ok(`${etiqueta}${bot.enabled === false ? ` ${C.dim}(deshabilitado)${C.off}` : ""}`);
  }

  head("Servicios locales");
  for (const [nombre, puerto] of [["Redis", 6379], ["PostgreSQL", 5432]]) {
    (await puertoAbierto(puerto))
      ? ok(`${nombre} responde en 127.0.0.1:${puerto}`)
      : warn(`${nombre} no responde en 127.0.0.1:${puerto}`);
  }

  console.log();
  if (fallas === 0) {
    console.log(`${C.green}Todo en orden.${C.off}\n`);
  } else {
    console.log(`${C.red}${fallas} problema(s) a resolver.${C.off}\n`);
    process.exit(1);
  }
}

function puertoAbierto(puerto, host = "127.0.0.1", timeout = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: puerto });
    const cerrar = (resultado) => {
      socket.destroy();
      resolve(resultado);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => cerrar(true));
    socket.once("timeout", () => cerrar(false));
    socket.once("error", () => cerrar(false));
  });
}

// --------------------------------- main ------------------------------------
const [comando, ...argv] = process.argv.slice(2);

switch (comando) {
  case "list": cmdList(); break;
  case "new": cmdNew(argv); break;
  case "rm": cmdRm(argv); break;
  case "doctor": await cmdDoctor(); break;
  default:
    console.log(`botctl — gestion del registro multibot

  list                                  estado de todos los bots
  new <nombre> [--port N] [--webhook]   crear un bot desde la plantilla
  rm <nombre> [--purge]                 dar de baja un bot
  doctor                                verificar entorno y registro
`);
    process.exit(comando ? 1 : 0);
}
