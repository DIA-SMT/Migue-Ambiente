# VPS multibot — `195.35.42.168`

Infra para correr varios bots de Node.js en la misma VPS, aislados entre sí
pero compartiendo Redis, Postgres y un core común.

## Estado — aplicado y verificado el 2026-08-19

`srv1915283` · Ubuntu 24.04.4 LTS · 2 vCPU · 7.8 GB RAM · 96 GB disco
· kernel 6.8.0-137 · TZ `America/Argentina/Tucuman`

| Componente | Estado |
|---|---|
| Node | v22.23.2 |
| pnpm | 11.22.0 |
| PM2 | 7.0.3 + `pm2-logrotate` 3.0.0, systemd `pm2-bots` **enabled** |
| Redis | active, sólo `127.0.0.1` |
| PostgreSQL | active, base `botsdb` / rol `bots` |
| nginx | active, `/healthz` → HTTP 200 |
| ufw | active, sólo 22/80/443 |
| fail2ban | active, jail `sshd` operativa |
| SSH | `passwordauthentication no`, `permitrootlogin without-password` |
| Swap | 2 GB, swappiness 10 |

Acceso por clave: `~/.ssh/multibot_vps` (root y `bots`). La clave privada
nunca salió de la máquina local.

**Pendiente tuyo:** cambiar la clave de root — se compartió por chat, así que
hay que considerarla comprometida. El password auth ya está deshabilitado,
así que no es explotable por SSH, pero sigue sirviendo para la consola web
del panel de Hostinger.

### Verificado end-to-end

Se creó un bot de prueba, se levantó bajo PM2 y se borró. Quedó comprobado:
arranque, log JSON, `SIGINT` → cierre ordenado → salida limpia; y el camino
de error (falta `BOT_TOKEN` → muere al arrancar nombrando la variable, con
backoff de PM2 en vez de reintento en bucle).

La resurrección de PM2 tras reboot está habilitada (`systemctl is-enabled
pm2-bots` → `enabled`) pero todavía no ejercitada: con cero bots registrados
el `dump.pm2` está vacío, así que no había nada que restaurar. Se confirma
solo cuando haya un bot real corriendo.

## Qué hace `provision.sh`

Idempotente — se puede correr todas las veces que quieras.

| Área | Qué queda configurado |
|---|---|
| Base | apt actualizado, build-essential, git, jq, rsync, htop |
| Zona horaria | `America/Argentina/Tucuman` + NTP |
| Swap | 2 GB, `swappiness=10` |
| Usuario | `bots` (sin password, solo clave SSH, sudo NOPASSWD) |
| Node | 22 LTS vía NodeSource + pnpm por corepack |
| Orquestador | PM2 + `pm2-logrotate` (20 MB, 14 días, comprimido) + arranque por systemd |
| Layout | `/srv/bots/{bots,packages,scripts,logs,backups}` |
| Firewall | ufw: deny incoming, solo 22/80/443 |
| Anti brute-force | fail2ban en sshd (4 intentos → ban 1 h) |
| Redis | solo localhost, 512 MB, `allkeys-lru`, AOF |
| PostgreSQL | base `botsdb` + rol `bots`, credenciales en `/srv/bots/.db-credentials` |
| nginx | reverse proxy con drop-ins en `/etc/nginx/bots.d/` + certbot |
| SSH | password auth **off**, root solo por clave (último paso, y solo si ya hay clave cargada) |
| Extras | unattended-upgrades, `nofile` 65535 |

```bash
sudo bash provision.sh                    # todo
sudo bash provision.sh --no-postgres      # sin Postgres
sudo bash provision.sh --no-harden        # sin tocar SSH
```

El hardening de SSH va **último** a propósito: si algo falla antes, no
quedamos sin acceso. Y se saltea solo si no encuentra ninguna clave
autorizada, para no dejarte afuera.

## Estructura del runtime (`../platform` → `/srv/bots`)

```
/srv/bots/
├── bots.json               ← fuente de verdad: qué bots existen
├── ecosystem.config.cjs    ← config de PM2, generada desde bots.json
├── packages/core/          ← @bots/core, compartido por todos
├── bots/
│   ├── _template/          ← plantilla base
│   └── <bot>/              ← un bot = una carpeta = un .env propio
├── scripts/botctl.mjs      ← alta y diagnóstico
└── logs/
```

**`bots.json` es la única fuente de verdad.** `ecosystem.config.cjs` lo lee y
genera las apps de PM2, valida que el entry exista y que no haya nombres
duplicados. No se edita la lista de apps a mano, así el registro nunca se
desincroniza de lo que corre de verdad.

### `@bots/core`

Lo que todo bot necesita y no conviene reescribir por bot:

- `createLogger(mod)` — pino, JSON en prod / coloreado en dev, con redacción
  automática de tokens y passwords
- `requireEnv([...])` — valida toda la config al arrancar y reporta **todas**
  las variables faltantes juntas, no una por corrida
- `onShutdown()` / `installShutdownHandlers()` — cierre ordenado en stack,
  con timeout, dentro del `kill_timeout` de 8 s de PM2
- `getRedis()` — cliente con `keyPrefix` por bot, así comparten Redis sin
  pisarse las claves
- `getDb()` / `query()` / `transaction()` — pool chico (5) a propósito: varios
  bots en una máquina agotan `max_connections` antes de necesitarlo
- `startHttpServer()` — `/healthz`, `/readyz` y webhooks, escuchando **solo**
  en `127.0.0.1` (nginx es el único que entra de afuera)

## Uso diario

```bash
# crear un bot
cd /srv/bots && node scripts/botctl.mjs new mibot --webhook
nano bots/mibot/.env          # cargar el token
pnpm install
pm2 start ecosystem.config.cjs --only mibot && pm2 save

# operar
node scripts/botctl.mjs list      # estado + memoria + reinicios
node scripts/botctl.mjs doctor    # valida entorno, registro, puertos, servicios
pm2 logs mibot
pm2 reload ecosystem.config.cjs --update-env

# dar de baja
node scripts/botctl.mjs rm mibot --purge   # baja de PM2 + registro + carpeta
pm2 save
```

### Deploy desde tu máquina

```bash
bash infra/deploy.sh --install
```

Sube `platform/` por `tar` sobre SSH (no necesita rsync en Windows), corre
`doctor` antes de tocar nada, y recarga sin downtime.

**Los bots se dan de alta en la VPS, no localmente.** `deploy.sh` excluye
`.env` y `bots.json` a propósito: los muta `botctl` en el servidor, así que si
el deploy los pisara desde local, cada subida desregistraría los bots dados de
alta allá — que es exactamente el bug que apareció la primera vez. El
`bots.json` local sólo se usa como semilla en el primer deploy, cuando la VPS
todavía no tiene registro.

## Decisiones que vale aclarar

- **PM2 y no systemd por bot**: `pm2 reload` recarga sin downtime, agrupa los
  logs y da métricas por bot con un solo comando. systemd queda igual abajo,
  para que todo levante solo al reiniciar la VPS.
- **pnpm workspaces**: cada bot declara sus propias dependencias y no hereda
  las de los demás, pero el core se comparte por link, sin duplicar.
- **`--env-file` nativo de Node**: cada bot lee sólo su `.env`, sin dotenv y
  sin riesgo de que un bot vea los secretos de otro.
- **`instances: 1` por defecto**: un bot con long polling o sesión de WhatsApp
  se rompe en cluster. Subilo sólo si el bot es realmente stateless.
