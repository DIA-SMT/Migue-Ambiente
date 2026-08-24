#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.sh — sube platform/ a la VPS y recarga los bots.
#
# Corre desde tu maquina (Git Bash sirve). Usa solo ssh + tar, asi que no
# necesita rsync instalado en Windows.
#
#   bash infra/deploy.sh              sube y recarga
#   bash infra/deploy.sh --no-reload  solo sube
#   bash infra/deploy.sh --install    sube y corre pnpm install
#   bash infra/deploy.sh --simular-limpieza   no borra nada, sólo lista
# ---------------------------------------------------------------------------
set -euo pipefail

VPS_HOST="${VPS_HOST:-195.35.42.168}"
VPS_USER="${VPS_USER:-bots}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/multibot_vps}"
APP_ROOT="${APP_ROOT:-/srv/bots}"

RELOAD=1
INSTALL=0
# Con --simular-limpieza el deploy dice qué archivos sobran en la VPS y no borra
# ninguno. Sirve para revisar la lista la primera vez.
LIMPIEZA_MODO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-reload) RELOAD=0 ;;
    --install)   INSTALL=1 ;;
    --simular-limpieza) LIMPIEZA_MODO="--simular" ;;
    *) echo "opcion desconocida: $1" >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$(cd "$SCRIPT_DIR/../platform" && pwd)"

[[ -f "$SSH_KEY" ]] || { echo "no encuentro la clave SSH en $SSH_KEY" >&2; exit 1; }
[[ -d "$PLATFORM_DIR" ]] || { echo "no encuentro $PLATFORM_DIR" >&2; exit 1; }

ssh_do() {
  ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 \
      "$VPS_USER@$VPS_HOST" "$@"
}

echo "==> Verificando acceso a $VPS_USER@$VPS_HOST"
ssh_do 'echo "    conectado a $(hostname)"'

echo "==> Subiendo platform/ -> $APP_ROOT"
# Exclusiones deliberadas:
#   .env, .env.*  credenciales. La copia de la VPS es la que vale, y un
#               `.env.local` de la maquina de desarrollo NO tiene que viajar:
#               Next lo lee con prioridad sobre `.env` y pisaria la config
#               del servidor.
#   bots.json   lo muta botctl EN el servidor. Si lo pisaramos desde local,
#               cada deploy desregistraria los bots dados de alta allá.
#   node_modules  se resuelve en la VPS con pnpm (binarios por plataforma)
#   .next       el build del panel se hace EN la VPS. Subir el local mezclaria
#               un build hecho en Windows con las dependencias de Linux.
tar -C "$PLATFORM_DIR" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='logs' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='bots.json' \
    --exclude='.pm2' \
    --exclude='.next' \
    -czf - . \
  | ssh_do "tar -C '$APP_ROOT' -xzf - && echo '    archivos actualizados'"

# Borrar lo que ya no existe en el origen.
#
# `tar -x` nunca borra, asi que un archivo renombrado o eliminado en el repo
# queda para siempre en el servidor. Eso tiro el panel abajo una vez: se
# renombro `middleware.ts` a `proxy.ts`, quedaron los dos, y Next 16 se niega a
# compilar con ambos.
#
# El manifiesto se saca del propio tar que se acaba de subir, asi que por
# construccion coincide con lo que se envio. La limpieza la hace un script
# aparte —infra/limpiar-sobrantes.sh— y no un heredoc dentro del ssh: aca se
# ejecuta `rm`, y las comillas anidadas entre el shell local y el remoto son la
# clase de error que en este caso costaria datos.
echo "==> Limpiando archivos que ya no existen en el repo"

MANIFIESTO_LOCAL="$(mktemp)"
tar -C "$PLATFORM_DIR"     --exclude='node_modules' --exclude='.git' --exclude='logs'     --exclude='.env' --exclude='.env.*' --exclude='bots.json'     --exclude='.pm2' --exclude='.next'     -czf - . | tar -tzf - | sed 's|^\./||' | grep -vE '/$' > "$MANIFIESTO_LOCAL"

scp -q -i "$SSH_KEY" -o BatchMode=yes "$MANIFIESTO_LOCAL" "$VPS_USER@$VPS_HOST:/tmp/manifiesto.txt"
scp -q -i "$SSH_KEY" -o BatchMode=yes "$SCRIPT_DIR/limpiar-sobrantes.sh"     "$VPS_USER@$VPS_HOST:/tmp/limpiar-sobrantes.sh"
rm -f "$MANIFIESTO_LOCAL"

ssh_do "bash /tmp/limpiar-sobrantes.sh '$APP_ROOT' /tmp/manifiesto.txt $LIMPIEZA_MODO
        rm -f /tmp/limpiar-sobrantes.sh /tmp/manifiesto.txt"

# Primer deploy: el servidor todavia no tiene registro, hay que sembrarlo.
if ssh_do "test ! -f '$APP_ROOT/bots.json'"; then
  echo "    sembrando bots.json inicial (no existia en la VPS)"
  scp -q -i "$SSH_KEY" -o BatchMode=yes \
      "$PLATFORM_DIR/bots.json" "$VPS_USER@$VPS_HOST:$APP_ROOT/bots.json"
fi

if [[ $INSTALL -eq 1 ]]; then
  echo "==> pnpm install en la VPS"
  ssh_do "cd '$APP_ROOT' && pnpm install --frozen-lockfile 2>/dev/null || pnpm install"
fi

# El .env del panel tiene que existir ANTES del build: las variables
# NEXT_PUBLIC_* se incrustan en el bundle que se sirve al navegador durante
# `next build`, no se leen al arrancar. Sin esto el panel compila igual pero el
# bundle queda con `undefined` donde va la URL de Supabase, y el login falla en
# el navegador con un error que no dice qué falta.
if ssh_do "test -d '$APP_ROOT/panel' && test ! -e '$APP_ROOT/panel/.env'"; then
  if ssh_do "test -f '$APP_ROOT/.secrets/panel.env'"; then
    echo "==> Enlazando panel/.env -> .secrets/panel.env"
    ssh_do "ln -s '$APP_ROOT/.secrets/panel.env' '$APP_ROOT/panel/.env' && echo '    enlazado'"
  else
    echo "    OJO: no existe $APP_ROOT/.secrets/panel.env; el panel va a compilar sin configuracion" >&2
  fi
fi

# El panel es lo unico que necesita compilarse. Se hace aca y no en cada
# arranque: `next start` sin un build previo falla, y PM2 lo reiniciaria en
# bucle igual que paso con el worker.
if ssh_do "test -d '$APP_ROOT/panel'"; then
  echo "==> Construyendo el panel"
  # El estado de salida se guarda ANTES de pasar la salida por `tail`. Con
  # `... build 2>&1 | tail -4`, el `if` evaluaba el estado de `tail`, que
  # siempre es 0: un build roto reportaba «build ok», el deploy seguia, y PM2
  # arrancaba `next start` sin build. Resultado: 502 en produccion.
  if ssh_do "cd '$APP_ROOT' && pnpm --filter @migue/panel build > /tmp/build-panel.log 2>&1; estado=\$?; tail -6 /tmp/build-panel.log; exit \$estado"; then
    echo "    build ok"
  else
    echo "    FALLO el build del panel. No se recarga nada para no dejarlo caido." >&2
    ssh_do "grep -iE 'error|Error' /tmp/build-panel.log | head -5" >&2 || true
    exit 1
  fi
fi

echo "==> Validando el registro"
ssh_do "cd '$APP_ROOT' && node scripts/botctl.mjs doctor"

if [[ $RELOAD -eq 1 ]]; then
  echo "==> Recargando bots (sin downtime)"
  ssh_do "cd '$APP_ROOT' && pm2 reload ecosystem.config.cjs --update-env && pm2 save"
  ssh_do "cd '$APP_ROOT' && node scripts/botctl.mjs list"
fi

echo "==> Listo"
