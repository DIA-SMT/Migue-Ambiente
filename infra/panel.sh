#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# panel.sh — publica el panel administrativo detrás de nginx, con HTTPS.
#
# Se corre UNA vez, cuando el subdominio ya resuelve a esta VPS. Después de eso
# los deploys del panel son `deploy.sh`, como cualquier bot.
#
#   bash infra/panel.sh --dominio ambiente.smt.gob.ar --correo mlujan@smt.gob.ar
#
#   --solo-generar   escribe el nginx.conf en /tmp y no toca la VPS
#   --sin-certbot    configura nginx pero no pide el certificado
#
# Por qué hace falta un dominio y no alcanza la IP: Let's Encrypt no emite
# certificados para una IP pelada, y un panel con login y datos de vecinos por
# HTTP plano manda la sesión y la contraseña en claro por la red.
#
# El archivo de nginx se arma LOCALMENTE y se copia con scp, en vez de
# escribirlo con un heredoc dentro de un comando ssh. Es a propósito: la
# combinación de comillas del shell local, del remoto y las variables propias de
# nginx ($host, $scheme) es una fuente de errores silenciosos, y así se puede
# revisar el archivo antes de que toque el servidor con `--solo-generar`.
# ---------------------------------------------------------------------------
set -euo pipefail

VPS_HOST="${VPS_HOST:-195.35.42.168}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/multibot_vps}"
PUERTO_PANEL="${PUERTO_PANEL:-3001}"

# El webhook de WhatsApp. Tiene que coincidir con WHATSAPP_WEBHOOK_PUERTO y
# WHATSAPP_WEBHOOK_RUTA del .env del bot; si no, nginx proxea a un puerto donde
# no hay nadie y Meta recibe 502 sin explicación.
PUERTO_WEBHOOK="${PUERTO_WEBHOOK:-3002}"
RUTA_WEBHOOK="${RUTA_WEBHOOK:-/hooks/whatsapp}"

DOMINIO=""
CORREO=""
CON_CERTBOT=1
SOLO_GENERAR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dominio)       DOMINIO="${2:-}"; shift ;;
    --correo)        CORREO="${2:-}"; shift ;;
    --sin-certbot)   CON_CERTBOT=0 ;;
    --solo-generar)  SOLO_GENERAR=1 ;;
    *) echo "opcion desconocida: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$DOMINIO" ]] || { echo "falta --dominio (ej: ambiente.smt.gob.ar)" >&2; exit 2; }
if [[ $CON_CERTBOT -eq 1 && $SOLO_GENERAR -eq 0 && -z "$CORREO" ]]; then
  echo "falta --correo: Let's Encrypt lo usa para avisar vencimientos" >&2
  exit 2
fi

ssh_root() { ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "root@$VPS_HOST" "$@"; }

# ---------------------------------------------------------------------------
# 1 · El archivo de nginx, armado acá
#
# Se escribe para el puerto 80 CON el proxy_pass real, no con un redirect. Es lo
# que espera `certbot --nginx --redirect`: copia este server a uno nuevo en 443
# con el certificado, y recién entonces convierte el de 80 en redirect. Si acá
# ya hubiera un redirect, certbot lo copiaría al 443 y el sitio quedaría
# redirigiéndose a sí mismo para siempre.
# ---------------------------------------------------------------------------
CONF_LOCAL="$(mktemp)"
trap 'rm -f "$CONF_LOCAL"' EXIT

cat > "$CONF_LOCAL" <<CONF
# Panel administrativo de Migue Ambiente.  Generado por infra/panel.sh
#
# nginx sólo hace de proxy: el panel es un Next.js que escucha en loopback y no
# está expuesto a internet. El único proceso que atiende de afuera es nginx, que
# es el que mantiene actualizado unattended-upgrades.
#
# El sitio por defecto (server_name _) sigue atendiendo el resto del puerto 80:
# nginx elige por server_name antes que por default_server.

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMINIO};

    # Certbot deja acá el desafío de validación del certificado.
    location /.well-known/acme-challenge/ { root /var/www/html; }

    # Los documentos que se suben desde el panel van DIRECTO a Supabase Storage
    # desde el navegador, no pasan por acá, así que 2 MB alcanza de sobra para
    # los formularios. Un tope alto sería superficie regalada.
    client_max_body_size 2m;

    # Webhook de WhatsApp Cloud API.
    #
    # POR QUÉ ACÁ Y NO EN /etc/nginx/bots.d/, que existe justo para esto. Los
    # drop-ins de bots.d cuelgan del server por defecto (server_name _), que
    # escucha SÓLO en el puerto 80. Meta exige HTTPS con certificado válido, y
    # el certificado lo tiene este server. Un webhook en bots.d nunca llega a
    # darse de alta.
    #
    # nginx elige por prefijo más largo, así que esto le gana a «location /»
    # sin depender del orden.
    location ${RUTA_WEBHOOK} {
        proxy_pass http://127.0.0.1:${PUERTO_WEBHOOK};
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Corto a propósito: el bot contesta 200 antes de procesar nada, así que
        # si tarda más que esto es que está caído, y conviene que Meta lo vea
        # como error rápido en vez de quedarse esperando.
        proxy_read_timeout 15s;
    }

    location / {
        proxy_pass http://127.0.0.1:${PUERTO_PANEL};
        proxy_http_version 1.1;

        # Next.js arma URLs absolutas —los redirects de Supabase Auth, las
        # server actions— a partir de estas cabeceras. Sin Host ni
        # X-Forwarded-Proto genera enlaces http:// apuntando a localhost, y el
        # login se va a una URL que no existe.
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host  \$host;

        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 60s;
        proxy_redirect off;
    }
}
CONF

echo "==> Archivo de nginx generado para $DOMINIO -> 127.0.0.1:$PUERTO_PANEL"
if [[ $SOLO_GENERAR -eq 1 ]]; then
  destino="/tmp/panel.nginx.conf"
  cp "$CONF_LOCAL" "$destino"
  echo "    escrito en $destino (no se tocó la VPS)"
  exit 0
fi

[[ -f "$SSH_KEY" ]] || { echo "no encuentro la clave SSH en $SSH_KEY" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 2 · El DNS tiene que resolver ANTES de pedir el certificado
#
# Hay un motivo para no intentarlo a ciegas: Let's Encrypt limita a 5 fallas por
# hora y por dominio, así que un intento apurado deja el dominio bloqueado un
# rato.
# ---------------------------------------------------------------------------
echo "==> Verificando que $DOMINIO resuelva a $VPS_HOST"
# Se consulta un DNS PÚBLICO y no `getent`, que resolvería por /etc/hosts.
#
# No es un detalle: Ubuntu pone el hostname de la máquina en /etc/hosts
# apuntando a 127.0.1.1, y Hostinger usa ese mismo nombre
# (srvNNNNNN.hstgr.cloud) como DNS inverso público de la IP. Con `getent`, el
# nombre correcto se rechazaba por «resuelve a 127.0.1.1». Lo que le importa a
# Let's Encrypt es el DNS público, que es lo que se consulta acá.
resuelto="$(ssh_root "dig +short +time=3 +tries=2 @1.1.1.1 '$DOMINIO' A 2>/dev/null | grep -E '^[0-9.]+$' | head -1" || true)"
if [[ -z "$resuelto" ]]; then
  resuelto="$(ssh_root "dig +short +time=3 +tries=2 @8.8.8.8 '$DOMINIO' A 2>/dev/null | grep -E '^[0-9.]+$' | head -1" || true)"
fi
if [[ -z "$resuelto" ]]; then
  cat >&2 <<AVISO
    $DOMINIO todavía no resuelve.
    Hay que pedir un registro A:   $DOMINIO   ->   $VPS_HOST
    El DNS puede tardar en propagarse; volvé a correr esto cuando resuelva.
AVISO
  exit 1
fi
if [[ "$resuelto" != "$VPS_HOST" ]]; then
  echo "    $DOMINIO resuelve a $resuelto, no a $VPS_HOST." >&2
  echo "    Si acabás de cambiar el DNS, esperá la propagación." >&2
  exit 1
fi
echo "    resuelve correctamente"

# ---------------------------------------------------------------------------
# 3 · Instalar y habilitar
# ---------------------------------------------------------------------------
echo "==> Instalando el sitio"
scp -q -i "$SSH_KEY" -o BatchMode=yes "$CONF_LOCAL" "root@$VPS_HOST:/etc/nginx/sites-available/panel"
ssh_root "ln -sf /etc/nginx/sites-available/panel /etc/nginx/sites-enabled/panel
  if nginx -t 2>/tmp/nginx.err; then
    systemctl reload nginx && echo '    nginx recargado'
  else
    echo '    FALLÓ la configuración de nginx:'; cat /tmp/nginx.err
    rm -f /etc/nginx/sites-enabled/panel
    echo '    sitio deshabilitado para no dejar nginx roto'
    exit 1
  fi"

# ---------------------------------------------------------------------------
# 4 · Cabeceras de seguridad
#
# Van en conf.d y no en el archivo del sitio: certbot reescribe el del sitio en
# cada renovación y se las llevaría puestas.
# ---------------------------------------------------------------------------
echo "==> Cabeceras de seguridad"
CAB_LOCAL="$(mktemp)"
cat > "$CAB_LOCAL" <<'CAB'
# Cabeceras del panel.  Generado por infra/panel.sh
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
CAB
scp -q -i "$SSH_KEY" -o BatchMode=yes "$CAB_LOCAL" "root@$VPS_HOST:/etc/nginx/conf.d/seguridad-panel.conf"
rm -f "$CAB_LOCAL"
ssh_root "nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo '    aplicadas'"

# ---------------------------------------------------------------------------
# 5 · El certificado
# ---------------------------------------------------------------------------
if [[ $CON_CERTBOT -eq 1 ]]; then
  echo "==> Certificado de Let's Encrypt"
  ssh_root "certbot --nginx -d '$DOMINIO' \
      --non-interactive --agree-tos --email '$CORREO' \
      --redirect --keep-until-expiring 2>&1 | tail -8"

  echo "==> Renovación automática"
  # Sin el timer, el certificado vence en 90 días y el panel deja de cargar sin
  # ningún aviso previo.
  ssh_root "systemctl is-active certbot.timer >/dev/null 2>&1 \
      && echo '    certbot.timer activo' \
      || { echo '    no estaba activo, se activa'; systemctl enable --now certbot.timer; }
    certbot renew --dry-run 2>&1 | tail -3"

  # HSTS recién ahora, con el certificado funcionando. Activarlo antes hace que
  # el navegador se niegue a entrar por HTTP y no haya forma de volver atrás
  # hasta que expire el max-age.
  echo "==> HSTS"
  ssh_root "grep -q Strict-Transport /etc/nginx/conf.d/seguridad-panel.conf \
      || echo \"add_header Strict-Transport-Security 'max-age=31536000' always;\" \
         >> /etc/nginx/conf.d/seguridad-panel.conf
    nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo '    activado'"
fi

echo
echo "==> Listo.  El panel va a quedar en:  https://$DOMINIO"
echo
echo "    FALTA cargarlo en Supabase -> Authentication -> URL Configuration:"
echo "      Site URL:       https://$DOMINIO"
echo "      Redirect URLs:  https://$DOMINIO/**"
echo "    Sin eso el login por correo redirige a localhost y no entra nadie."
