/**
 * Config de PM2 generada a partir de bots.json.
 *
 * No editar la lista de apps a mano: agregá/quitá bots en bots.json y PM2
 * lo toma solo. Asi el registro no se desincroniza del proceso real.
 *
 *   pm2 start ecosystem.config.cjs          arranca todo lo habilitado
 *   pm2 reload ecosystem.config.cjs         recarga sin downtime
 *   pm2 start ecosystem.config.cjs --only X arranca un solo bot
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, "logs");
const registryPath = path.join(ROOT, "bots.json");

function readRegistry() {
  let raw;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (err) {
    throw new Error(`No pude leer ${registryPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`bots.json tiene JSON invalido: ${err.message}`);
  }
  if (!Array.isArray(parsed.bots)) {
    throw new Error('bots.json debe tener un array en la clave "bots"');
  }
  return parsed.bots;
}

function validate(bot, index) {
  const where = `bots[${index}]${bot.name ? ` (${bot.name})` : ""}`;
  for (const field of ["name", "dir", "entry"]) {
    if (!bot[field] || typeof bot[field] !== "string") {
      throw new Error(`${where}: falta el campo obligatorio "${field}"`);
    }
  }
  const cwd = path.join(ROOT, "bots", bot.dir);
  if (!fs.existsSync(path.join(cwd, bot.entry))) {
    throw new Error(`${where}: no existe el entry ${path.join(cwd, bot.entry)}`);
  }
  return cwd;
}

const seen = new Set();

const apps = readRegistry()
  .filter((bot) => bot.enabled !== false)
  .map((bot, index) => {
    const cwd = validate(bot, index);

    if (seen.has(bot.name)) {
      throw new Error(`bots.json: el nombre "${bot.name}" esta duplicado`);
    }
    seen.add(bot.name);

    const instances = bot.instances ?? 1;
    const isCluster = instances === "max" || Number(instances) > 1;

    return {
      name: bot.name,
      cwd,
      script: bot.entry,
      interpreter: "node",
      // --env-file hace que cada bot lea SU propio .env, sin pisar a los demas
      node_args: fs.existsSync(path.join(cwd, ".env"))
        ? ["--env-file=.env"]
        : [],

      instances,
      exec_mode: isCluster ? "cluster" : "fork",

      // Reinicio: exponencial, y si crashea muy seguido lo damos por roto
      autorestart: true,
      restart_delay: 2000,
      exp_backoff_restart_delay: 250,
      max_restarts: 15,
      min_uptime: "20s",

      max_memory_restart: bot.maxMemory || "400M",
      kill_timeout: 8000, // margen para el shutdown ordenado
      wait_ready: false,
      listen_timeout: 10000,

      // Logs por bot, con timestamp, para que pm2-logrotate los rote
      output: path.join(LOG_DIR, `${bot.name}.out.log`),
      error: path.join(LOG_DIR, `${bot.name}.err.log`),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: process.env.NODE_ENV || "production",
        BOT_NAME: bot.name,
        TZ: process.env.TZ || "America/Argentina/Tucuman",
        ...(bot.port ? { PORT: String(bot.port) } : {}),
        ...(bot.env || {}),
      },
    };
  });

if (apps.length === 0) {
  console.warn(
    "[ecosystem] No hay bots habilitados en bots.json — PM2 no va a arrancar nada.",
  );
}

module.exports = { apps };
