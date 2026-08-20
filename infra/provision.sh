#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# provision.sh — Prepara una VPS Ubuntu para correr multiples bots en Node.js
#
# Idempotente: se puede correr N veces sin romper nada.
# Uso:  sudo bash provision.sh [opciones]
#
# Opciones:
#   --no-postgres      no instalar PostgreSQL
#   --no-redis         no instalar Redis
#   --no-nginx         no instalar nginx/certbot
#   --no-harden        no tocar la config de SSH
#   --node-major N     version mayor de Node (default 22)
# ---------------------------------------------------------------------------
set -euo pipefail

# ------------------------------ configuracion ------------------------------
DEPLOY_USER="${DEPLOY_USER:-bots}"
APP_ROOT="${APP_ROOT:-/srv/bots}"
NODE_MAJOR="${NODE_MAJOR:-22}"
TIMEZONE="${TIMEZONE:-America/Argentina/Tucuman}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
PG_DB="${PG_DB:-botsdb}"
PG_USER="${PG_USER:-bots}"

WITH_POSTGRES=1
WITH_REDIS=1
WITH_NGINX=1
WITH_HARDEN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-postgres) WITH_POSTGRES=0 ;;
    --no-redis)    WITH_REDIS=0 ;;
    --no-nginx)    WITH_NGINX=0 ;;
    --no-harden)   WITH_HARDEN=0 ;;
    --node-major)  NODE_MAJOR="$2"; shift ;;
    *) echo "opcion desconocida: $1" >&2; exit 2 ;;
  esac
  shift
done

# --------------------------------- helpers ---------------------------------
C_OK=$'\033[0;32m'; C_INFO=$'\033[0;36m'; C_WARN=$'\033[0;33m'; C_OFF=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$C_INFO" "$C_OFF" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$C_OK"   "$C_OFF" "$*"; }
warn() { printf '%s  !!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "corré esto como root (sudo bash provision.sh)"
[[ -f /etc/os-release ]] || die "no encuentro /etc/os-release"
. /etc/os-release
[[ "${ID:-}" == "ubuntu" || "${ID_LIKE:-}" == *debian* ]] \
  || die "este script asume Ubuntu/Debian (detecté: ${PRETTY_NAME:-desconocido})"

export DEBIAN_FRONTEND=noninteractive
# needrestart en Ubuntu 24.04 pregunta que servicios reiniciar; 'a' = todos,
# sin prompt. Sin esto el script se cuelga esperando input que nunca llega.
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

# Ante un conflicto de conffile, quedarse con la version actual en vez de
# abrir un dialogo interactivo.
APT_OPTS=(-y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
apt_install() { apt-get install "${APT_OPTS[@]}" "$@"; }

# escribe $2 en el archivo $1 solo si el contenido cambió; devuelve 0 si cambió
write_if_changed() {
  local path="$1" content="$2"
  if [[ -f "$path" ]] && printf '%s' "$content" | cmp -s - "$path"; then
    return 1
  fi
  mkdir -p "$(dirname "$path")"
  printf '%s' "$content" > "$path"
  return 0
}

# mantiene un bloque delimitado dentro de un archivo existente (para configs
# que no soportan drop-ins). Devuelve 0 si el archivo cambió, 1 si ya estaba.
manage_block() {
  local path="$1" body="$2" cc="${3:-#}"
  local begin="$cc >>> provision.sh managed block (no editar a mano)"
  local end="$cc <<< provision.sh managed block"
  local desired current tmp
  desired="$begin"$'\n'"$body$end"$'\n'

  [[ -f "$path" ]] || touch "$path"

  current="$(awk -v b="$begin" -v e="$end" \
    '$0==b {inb=1} inb {print} $0==e {inb=0}' "$path")"
  [[ -n "$current" ]] && current="$current"$'\n'

  [[ "$current" == "$desired" ]] && return 1

  tmp="$(mktemp)"
  awk -v b="$begin" -v e="$end" \
    '$0==b {inb=1; next} $0==e {inb=0; next} !inb {print}' "$path" > "$tmp"
  printf '%s' "$desired" >> "$tmp"
  cat "$tmp" > "$path"          # cat preserva dueño y permisos del original
  rm -f "$tmp"
  return 0
}

as_deploy() { sudo -u "$DEPLOY_USER" -H bash -lc "$*"; }

# ================================== pasos ==================================

step_base() {
  log "Paquetes base y actualizaciones"
  apt-get update -qq
  apt-get upgrade "${APT_OPTS[@]}"
  apt_install \
    ca-certificates curl gnupg lsb-release apt-transport-https \
    git build-essential python3 pkg-config \
    ufw fail2ban unattended-upgrades \
    unzip zip jq rsync acl logrotate \
    htop tmux ncdu dnsutils net-tools
  ok "paquetes base instalados"
}

step_timezone() {
  log "Zona horaria y locale"
  # Consultar a timedatectl, no a /etc/timezone: en systemd ese archivo es un
  # resto de Debian que no siempre se reescribe, asi que da falsos negativos.
  local actual; actual="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  if [[ "$actual" != "$TIMEZONE" ]]; then
    timedatectl set-timezone "$TIMEZONE"
    ok "timezone -> $TIMEZONE"
  else
    ok "timezone ya era $TIMEZONE"
  fi
  timedatectl set-ntp true 2>/dev/null || true
}

step_swap() {
  log "Swap"
  if [[ -n "$(swapon --show --noheadings 2>/dev/null)" ]]; then
    ok "ya hay swap activo"
    return
  fi
  fallocate -l "$SWAP_SIZE" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -qw vm.swappiness=10
  write_if_changed /etc/sysctl.d/99-swappiness.conf $'vm.swappiness=10\n' >/dev/null || true
  ok "swap de $SWAP_SIZE creado"
}

step_user() {
  log "Usuario de deploy: $DEPLOY_USER"
  if id "$DEPLOY_USER" &>/dev/null; then
    ok "el usuario ya existe"
  else
    adduser --disabled-password --gecos "" "$DEPLOY_USER" >/dev/null
    ok "usuario creado (sin password, solo clave SSH)"
  fi
  usermod -aG sudo "$DEPLOY_USER"

  # sudo sin password: la caja es single-admin y el acceso es solo por clave
  if write_if_changed "/etc/sudoers.d/90-$DEPLOY_USER" \
      "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL"$'\n'; then
    chmod 440 "/etc/sudoers.d/90-$DEPLOY_USER"
    visudo -cf "/etc/sudoers.d/90-$DEPLOY_USER" >/dev/null || die "sudoers inválido"
    ok "sudo NOPASSWD configurado"
  fi

  # replicar las claves autorizadas de root en el usuario de deploy
  local home; home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
  if [[ -f /root/.ssh/authorized_keys ]]; then
    touch "$home/.ssh/authorized_keys"
    # agregar solo las que falten
    while IFS= read -r key; do
      [[ -z "$key" || "$key" == \#* ]] && continue
      grep -qxF "$key" "$home/.ssh/authorized_keys" || echo "$key" >> "$home/.ssh/authorized_keys"
    done < /root/.ssh/authorized_keys
    chmod 600 "$home/.ssh/authorized_keys"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
    ok "claves SSH replicadas a $DEPLOY_USER"
  else
    warn "root no tiene authorized_keys; $DEPLOY_USER queda sin acceso SSH"
  fi
}

step_node() {
  log "Node.js $NODE_MAJOR + pnpm"
  local current=""
  command -v node >/dev/null && current="$(node -v)"
  if [[ "$current" == v${NODE_MAJOR}.* ]]; then
    ok "Node ya instalado ($current)"
  else
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    chmod 644 /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt_install nodejs
    ok "Node instalado ($(node -v))"
  fi

  corepack enable >/dev/null 2>&1 || npm i -g corepack >/dev/null 2>&1
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || npm i -g pnpm >/dev/null 2>&1
  ok "pnpm $(pnpm -v 2>/dev/null || echo '?') listo"
}

step_pm2() {
  log "PM2 (orquestador multibot)"
  if ! command -v pm2 >/dev/null; then
    npm i -g pm2 >/dev/null 2>&1
    ok "pm2 instalado ($(pm2 -v))"
  else
    ok "pm2 ya instalado ($(pm2 -v))"
  fi

  # rotacion de logs de pm2
  as_deploy "pm2 describe pm2-logrotate >/dev/null 2>&1 || pm2 install pm2-logrotate" >/dev/null 2>&1 || true
  as_deploy "pm2 set pm2-logrotate:max_size 20M;
             pm2 set pm2-logrotate:retain 14;
             pm2 set pm2-logrotate:compress true;
             pm2 set pm2-logrotate:rotateInterval '0 0 * * *'" >/dev/null 2>&1 || true

  # arranque automatico via systemd, corriendo como el usuario de deploy
  if [[ ! -f /etc/systemd/system/pm2-$DEPLOY_USER.service ]]; then
    env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$DEPLOY_USER" \
        --hp "$(getent passwd "$DEPLOY_USER" | cut -d: -f6)" >/dev/null
    ok "servicio systemd pm2-$DEPLOY_USER creado"
  else
    ok "servicio systemd de pm2 ya existía"
  fi
  systemctl enable "pm2-$DEPLOY_USER" >/dev/null 2>&1 || true
}

step_layout() {
  log "Estructura de directorios en $APP_ROOT"
  install -d -m 2775 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
    "$APP_ROOT" "$APP_ROOT/bots" "$APP_ROOT/logs" \
    "$APP_ROOT/scripts" "$APP_ROOT/packages" "$APP_ROOT/backups"
  # los archivos nuevos heredan el grupo -> deploys sin pelearse con permisos
  setfacl -R -d -m u:"$DEPLOY_USER":rwx -m g:"$DEPLOY_USER":rwx "$APP_ROOT" 2>/dev/null || true
  ok "layout creado"
}

step_firewall() {
  log "Firewall (ufw)"
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  ufw allow 22/tcp   comment 'ssh'   >/dev/null
  ufw allow 80/tcp   comment 'http'  >/dev/null
  ufw allow 443/tcp  comment 'https' >/dev/null
  if ! ufw status | grep -q '^Status: active'; then
    ufw --force enable >/dev/null
    ok "ufw activado"
  else
    ok "ufw ya estaba activo"
  fi
}

step_fail2ban() {
  log "fail2ban"
  local jail
  jail=$'[sshd]\nenabled = true\nport = ssh\nmaxretry = 4\nfindtime = 10m\nbantime = 1h\nbackend = systemd\n'
  if write_if_changed /etc/fail2ban/jail.d/sshd.local "$jail"; then
    systemctl restart fail2ban
    ok "jail de sshd configurada"
  else
    ok "fail2ban ya configurado"
  fi
  systemctl enable fail2ban >/dev/null 2>&1 || true
}

step_harden_ssh() {
  if [[ $WITH_HARDEN -eq 0 ]]; then warn "hardening de SSH salteado (--no-harden)"; return; fi
  log "Hardening de SSH"

  # Seguro: no tocar nada si no hay ninguna clave autorizada
  if [[ ! -s /root/.ssh/authorized_keys ]]; then
    warn "no hay claves en /root/.ssh/authorized_keys — NO deshabilito el password (te dejaría afuera)"
    return
  fi

  # OJO con el nombre del archivo: sshd toma el PRIMER valor que encuentra
  # para cada keyword, y las imagenes de cloud dejan un
  # /etc/ssh/sshd_config.d/50-cloud-init.conf con 'PasswordAuthentication yes'.
  # Un 99-*.conf se lee despues y nunca gana. Por eso el prefijo 00.
  local conf_path=/etc/ssh/sshd_config.d/00-hardening.conf
  rm -f /etc/ssh/sshd_config.d/99-hardening.conf   # de corridas anteriores

  local conf
  conf=$'# gestionado por provision.sh — prefijo 00 para ganarle a los drop-ins\n'
  conf+=$'# de cloud-init, que sshd leeria primero.\n'
  conf+=$'PasswordAuthentication no\n'
  conf+=$'KbdInteractiveAuthentication no\n'
  conf+=$'PermitRootLogin prohibit-password\n'
  conf+=$'PubkeyAuthentication yes\n'
  conf+=$'PermitEmptyPasswords no\n'
  conf+=$'MaxAuthTries 4\n'
  conf+=$'X11Forwarding no\n'
  conf+=$'ClientAliveInterval 120\n'
  conf+=$'ClientAliveCountMax 3\n'

  local changed=0
  write_if_changed "$conf_path" "$conf" && changed=1

  # cloud-init reescribe su drop-in en cada boot segun ssh_pwauth. Le decimos
  # que no toque SSH, asi el hardening sobrevive a los reinicios.
  local ci=/etc/cloud/cloud.cfg.d/99-disable-ssh-pwauth.cfg
  if [[ -d /etc/cloud/cloud.cfg.d ]]; then
    write_if_changed "$ci" $'# gestionado por provision.sh\nssh_pwauth: false\n' && changed=1
  fi

  if [[ $changed -eq 0 ]]; then
    ok "SSH ya estaba endurecido"
    return
  fi

  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    # Verificar el valor EFECTIVO, no solo que el archivo exista
    local efectivo; efectivo="$(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')"
    if [[ "$efectivo" == "no" ]]; then
      ok "password auth deshabilitado (efectivo), root solo por clave"
    else
      warn "escribí la config pero sshd sigue con passwordauthentication=$efectivo"
      warn "revisá que no haya otro drop-in en /etc/ssh/sshd_config.d/ ganando"
    fi
  else
    rm -f "$conf_path"
    die "la config de sshd no valida; revertí el cambio"
  fi
}

step_redis() {
  if [[ $WITH_REDIS -eq 0 ]]; then warn "Redis salteado"; return; fi
  log "Redis (cache / colas / rate-limit de los bots)"
  apt_install redis-server

  # redis 'include' no acepta globs, así que gestionamos un bloque marcado
  # dentro del redis.conf principal (las últimas directivas ganan).
  local block
  block=$'bind 127.0.0.1 ::1\n'
  block+=$'protected-mode yes\n'
  block+=$'maxmemory 512mb\n'
  block+=$'maxmemory-policy allkeys-lru\n'
  block+=$'appendonly yes\n'
  if manage_block /etc/redis/redis.conf "$block" '#'; then
    systemctl restart redis-server 2>/dev/null || true
    ok "Redis configurado (solo localhost, 512mb, LRU, AOF)"
  else
    ok "Redis ya configurado"
  fi
  systemctl enable --now redis-server >/dev/null 2>&1 || true
}

step_postgres() {
  if [[ $WITH_POSTGRES -eq 0 ]]; then warn "PostgreSQL salteado"; return; fi
  log "PostgreSQL"
  apt_install postgresql postgresql-contrib
  systemctl enable --now postgresql >/dev/null 2>&1 || true

  local pass_file="/root/.pg_${PG_USER}_password"
  if [[ ! -f "$pass_file" ]]; then
    openssl rand -base64 30 | tr -d '\n/+=' | head -c 32 > "$pass_file"
    chmod 600 "$pass_file"
  fi
  local pgpass; pgpass="$(cat "$pass_file")"

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1; then
    sudo -u postgres psql -q -c "CREATE ROLE $PG_USER LOGIN PASSWORD '$pgpass';"
    ok "rol $PG_USER creado"
  else
    sudo -u postgres psql -q -c "ALTER ROLE $PG_USER PASSWORD '$pgpass';"
    ok "rol $PG_USER ya existía (password sincronizado)"
  fi
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1; then
    sudo -u postgres createdb -O "$PG_USER" "$PG_DB"
    ok "base $PG_DB creada"
  else
    ok "base $PG_DB ya existía"
  fi

  # dejar la URL de conexion a mano para los .env de los bots
  local envline="DATABASE_URL=postgresql://$PG_USER:$pgpass@127.0.0.1:5432/$PG_DB"
  write_if_changed "$APP_ROOT/.db-credentials" "$envline"$'\n' >/dev/null || true
  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_ROOT/.db-credentials"
  chmod 600 "$APP_ROOT/.db-credentials"
  ok "credenciales en $APP_ROOT/.db-credentials"
}

step_nginx() {
  if [[ $WITH_NGINX -eq 0 ]]; then warn "nginx salteado"; return; fi
  log "nginx + certbot (para webhooks / dashboards)"
  apt_install nginx certbot python3-certbot-nginx
  local conf
  conf=$'# Reverse proxy de los bots. Cada bot expone su puerto local y se mapea acá.\n'
  conf+=$'# Ejemplo:\n'
  conf+=$'#   location /hooks/mibot/ { proxy_pass http://127.0.0.1:3001/; }\n'
  conf+=$'server {\n'
  conf+=$'    listen 80 default_server;\n'
  conf+=$'    listen [::]:80 default_server;\n'
  conf+=$'    server_name _;\n\n'
  conf+=$'    location /healthz { return 200 "ok\\n"; add_header Content-Type text/plain; }\n\n'
  conf+=$'    include /etc/nginx/bots.d/*.conf;\n\n'
  conf+=$'    location / { return 404; }\n'
  conf+=$'}\n'
  install -d -m 755 /etc/nginx/bots.d
  if write_if_changed /etc/nginx/sites-available/bots "$conf"; then
    ln -sfn /etc/nginx/sites-available/bots /etc/nginx/sites-enabled/bots
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl reload nginx
    ok "nginx configurado (drop-ins en /etc/nginx/bots.d/)"
  else
    ok "nginx ya configurado"
  fi
  systemctl enable --now nginx >/dev/null 2>&1 || true
}

step_unattended() {
  log "Actualizaciones de seguridad automáticas"
  local conf
  conf=$'APT::Periodic::Update-Package-Lists "1";\n'
  conf+=$'APT::Periodic::Unattended-Upgrade "1";\n'
  conf+=$'APT::Periodic::AutocleanInterval "7";\n'
  write_if_changed /etc/apt/apt.conf.d/20auto-upgrades "$conf" >/dev/null && ok "activadas" || ok "ya activadas"
}

step_limits() {
  log "Límites del sistema (file descriptors)"
  local conf
  conf=$'* soft nofile 65535\n* hard nofile 65535\nroot soft nofile 65535\nroot hard nofile 65535\n'
  write_if_changed /etc/security/limits.d/99-bots.conf "$conf" >/dev/null && ok "nofile 65535" || ok "ya configurado"
}

step_summary() {
  echo
  printf '%s================ RESUMEN ================%s\n' "$C_OK" "$C_OFF"
  printf '  Host       : %s (%s)\n' "$(hostname)" "${PRETTY_NAME:-?}"
  printf '  Kernel     : %s\n' "$(uname -r)"
  printf '  CPU / RAM  : %s vCPU / %s\n' "$(nproc)" "$(free -h | awk '/^Mem:/{print $2}')"
  printf '  Disco      : %s libres de %s\n' "$(df -h / | awk 'NR==2{print $4}')" "$(df -h / | awk 'NR==2{print $2}')"
  printf '  Timezone   : %s\n' "$(timedatectl show -p Timezone --value 2>/dev/null)"
  printf '  SSH passwd : %s\n' "$(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')"
  printf '  Node       : %s\n' "$(node -v 2>/dev/null || echo '-')"
  printf '  pnpm       : %s\n' "$(pnpm -v 2>/dev/null || echo '-')"
  printf '  PM2        : %s\n' "$(pm2 -v 2>/dev/null || echo '-')"
  printf '  Redis      : %s\n' "$(systemctl is-active redis-server 2>/dev/null || echo '-')"
  printf '  PostgreSQL : %s\n' "$(systemctl is-active postgresql 2>/dev/null || echo '-')"
  printf '  nginx      : %s\n' "$(systemctl is-active nginx 2>/dev/null || echo '-')"
  printf '  ufw        : %s\n' "$(ufw status | head -1 | awk '{print $2}')"
  printf '  fail2ban   : %s\n' "$(systemctl is-active fail2ban 2>/dev/null || echo '-')"
  printf '  Deploy user: %s  ->  %s\n' "$DEPLOY_USER" "$APP_ROOT"
  printf '%s=========================================%s\n' "$C_OK" "$C_OFF"
}

# =================================== main ==================================
step_base
step_timezone
step_swap
step_user
step_node
step_layout
step_pm2
step_firewall
step_fail2ban
step_redis
step_postgres
step_nginx
step_unattended
step_limits
step_harden_ssh   # ultimo: si algo falla antes, no quedamos sin acceso
step_summary
