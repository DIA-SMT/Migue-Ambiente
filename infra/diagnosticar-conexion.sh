#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# diagnosticar-conexion.sh — ¿está el bot bien conectado a Supabase?
#
#   bash infra/diagnosticar-conexion.sh
#
# Corre DENTRO de la VPS y prueba lo que de verdad importa cuando algo se cae a
# las tres de la mañana. No comprueba que las variables estén: comprueba que
# funcionen, y que la clave que usa cada proceso sea la que le corresponde.
#
# Lo que busca, en orden de qué tan caro es que falle:
#
#   1. Que los tres procesos tengan las variables que necesitan.
#   2. Que la clave del bot y del worker sea `service_role` y la del navegador
#      del panel sea `anon`. Al revés es un incidente: la clave del sistema
#      viajando al navegador de cualquiera.
#   3. Que Supabase responda, y cuánto tarda desde la VPS.
#   4. Que Redis responda, porque ahí vive el estado de los trámites a medias.
#   5. Qué pasa cuando Supabase NO responde: si el bot se cae o aguanta.
#   6. Que no haya claves en los logs.
#
# NOTA sobre donde viven las variables: cada bot tiene SU propio `.env` en su
# carpeta, y PM2 lo carga con `--env-file` poniendo el cwd ahi. Eso hace que las
# claves NO aparezcan en /proc/PID/environ —Node las mete en `process.env` al
# arrancar, no en el entorno del sistema— y es una propiedad deseable: un
# `ps eww` no las muestra.
# ---------------------------------------------------------------------------
set -uo pipefail

VPS_HOST="${VPS_HOST:-195.35.42.168}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/multibot_vps}"
APP="/srv/bots"

ssh_do() { ssh -i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes "root@$VPS_HOST" "$@"; }

titulo() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()     { printf '  \033[32mok\033[0m   %s\n' "$1"; }
mal()    { printf '  \033[31mMAL\033[0m  %s\n' "$1"; }
dato()   { printf '       %s\n' "$1"; }

# ---------------------------------------------------------------------------
titulo "Las variables de cada proceso"
# ---------------------------------------------------------------------------
# Se comprueba la PRESENCIA y el PREFIJO, nunca el valor. Un script de
# diagnóstico que imprime una clave la deja en el historial del shell y en
# cualquier captura de pantalla.
ssh_do "cd $APP
for env in bots/migue-ambiente/.env panel/.env; do
  [ -f \"\$env\" ] || { echo \"  FALTA \$env\"; continue; }
  echo \"  \$env:\"
  while IFS='=' read -r k v; do
    case \"\$k\" in
      ''|\#*) continue ;;
    esac
    v=\$(echo \"\$v\" | tr -d '\"' | tr -d \"'\")
    largo=\${#v}
    case \"\$k\" in
      *KEY|*TOKEN|*SECRET|*PASSWORD)
        # De un JWT de Supabase se puede leer el rol sin exponer la firma: el
        # payload es la segunda parte, en base64.
        rol=''
        case \"\$v\" in
          eyJ*) rol=\$(echo \"\$v\" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | grep -o '\"role\":\"[a-z_]*\"' | cut -d'\"' -f4) ;;
        esac
        printf '    %-34s presente (%s caracteres)%s\n' \"\$k\" \"\$largo\" \"\${rol:+ rol=\$rol}\"
        ;;
      *URL|*_URL)
        printf '    %-34s %s\n' \"\$k\" \"\$v\"
        ;;
      *)
        printf '    %-34s %s\n' \"\$k\" \"\$v\"
        ;;
    esac
  done < \"\$env\"
done"

# ---------------------------------------------------------------------------
titulo "El rol de cada clave"
# ---------------------------------------------------------------------------
# El error que importa: la clave `service_role` saltea TODO el RLS. Si viajara al
# navegador —cualquier variable con prefijo NEXT_PUBLIC_ viaja— cualquiera que
# abriera el panel podría leer y escribir todo.
ssh_do "cd $APP
publica=\$(grep -o 'NEXT_PUBLIC_SUPABASE_ANON_KEY=[^[:space:]]*' panel/.env 2>/dev/null | cut -d= -f2- | tr -d '\"')
if [ -n \"\$publica\" ]; then
  rol=\$(echo \"\$publica\" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | grep -o '\"role\":\"[a-z_]*\"' | cut -d'\"' -f4)
  if [ \"\$rol\" = anon ]; then
    echo \"  ok   la clave que viaja al navegador es 'anon'\"
  else
    echo \"  MAL  la clave del navegador tiene rol '\$rol': tiene que ser 'anon'\"
  fi
else
  echo \"  MAL  el panel no tiene NEXT_PUBLIC_SUPABASE_ANON_KEY\"
fi

# Y al revés: que NINGUNA variable con prefijo publico tenga service_role.
fuga=0
for env in bots/migue-ambiente/.env panel/.env; do
  [ -f \"\$env\" ] || continue
  while IFS='=' read -r k v; do
    case \"\$k\" in NEXT_PUBLIC_*) ;; *) continue ;; esac
    v=\$(echo \"\$v\" | tr -d '\"')
    case \"\$v\" in
      eyJ*)
        rol=\$(echo \"\$v\" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | grep -o '\"role\":\"[a-z_]*\"' | cut -d'\"' -f4)
        if [ \"\$rol\" = service_role ]; then
          echo \"  MAL  \$env: \$k lleva la clave service_role al NAVEGADOR\"
          fuga=1
        fi
        ;;
    esac
  done < \"\$env\"
done
[ \$fuga -eq 0 ] && echo \"  ok   ninguna variable publica lleva la clave del sistema\"

# El bot y el worker sí necesitan service_role: leen y escriben en nombre del
# municipio, no de un vecino.
del_bot=\$(grep -o 'SUPABASE_SERVICE_ROLE_KEY=[^[:space:]]*' bots/migue-ambiente/.env 2>/dev/null | cut -d= -f2- | tr -d '\"')
if [ -n \"\$del_bot\" ]; then
  rol=\$(echo \"\$del_bot\" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | grep -o '\"role\":\"[a-z_]*\"' | cut -d'\"' -f4)
  [ \"\$rol\" = service_role ] && echo \"  ok   el bot y el worker usan 'service_role'\" \\
                              || echo \"  MAL  la clave del bot tiene rol '\$rol'\"
fi"

# ---------------------------------------------------------------------------
titulo "Supabase responde, y cuánto tarda"
# ---------------------------------------------------------------------------
# Tres mediciones desde la VPS, que es donde importa: el bot atiende a un vecino
# que está esperando.
ssh_do "cd $APP
url=\$(grep -o 'SUPABASE_URL=[^[:space:]]*' bots/migue-ambiente/.env | head -1 | cut -d= -f2- | tr -d '\"')
clave=\$(grep -o 'SUPABASE_SERVICE_ROLE_KEY=[^[:space:]]*' bots/migue-ambiente/.env | head -1 | cut -d= -f2- | tr -d '\"')

echo \"  host: \$(echo \$url | sed 's|https://||')\"
printf '  dns:  '
getent hosts \$(echo \$url | sed 's|https://||') | head -1 | awk '{print \$1}' || echo 'no resuelve'

for i in 1 2 3; do
  t=\$(curl -s -o /dev/null -w '%{time_total} %{http_code}' \\
       -H \"apikey: \$clave\" -H \"Authorization: Bearer \$clave\" \\
       \"\$url/rest/v1/configuracion?select=clave&limit=1\")
  ms=\$(echo \$t | awk '{printf \"%.0f\", \$1*1000}')
  cod=\$(echo \$t | awk '{print \$2}')
  printf '  intento %s: HTTP %s en %s ms\n' \$i \$cod \$ms
done

# Storage, que es un servicio aparte y puede fallar solo.
printf '  storage: '
curl -s -o /dev/null -w 'HTTP %{http_code} en %{time_total}s\n' \\
  -H \"Authorization: Bearer \$clave\" \"\$url/storage/v1/bucket\""

# ---------------------------------------------------------------------------
titulo "Redis: donde vive el estado de los trámites a medias"
# ---------------------------------------------------------------------------
# Si Redis se cae, un vecino a mitad de un pedido pierde el hilo. No es
# catastrófico —el próximo mensaje empieza de nuevo— pero conviene saberlo.
ssh_do "redis-cli ping 2>/dev/null | sed 's/^/  respuesta: /' || echo '  MAL  Redis no responde'
n=\$(redis-cli --scan --pattern 'flujo:*' 2>/dev/null | wc -l)
echo \"  tramites a medias guardados: \$n\"
redis-cli info memory 2>/dev/null | grep -E 'used_memory_human' | sed 's/^/  /'
redis-cli config get maxmemory-policy 2>/dev/null | tail -1 | sed 's/^/  politica al llenarse: /'"

# ---------------------------------------------------------------------------
titulo "Qué pasa si Supabase no responde"
# ---------------------------------------------------------------------------
# Lo importante no es que nunca falle: es que cuando falle, el bot no se muera y
# el vecino reciba algo.
ssh_do "cd $APP
echo '  reintentos configurados en el codigo:'
grep -rn 'reintent\|retry\|MAX_INTENTOS\|backoff' packages/migue-dominio/src/datos/cliente.ts 2>/dev/null | head -4 | sed 's/^/    /' || echo '    (ninguno en cliente.ts)'
echo '  el bot arranca si Supabase no responde?'
grep -rn 'Supabase responde\|verificarConexion\|process.exit' bots/migue-ambiente/src/index.ts 2>/dev/null | head -3 | sed 's/^/    /'
echo '  reinicios de PM2 hoy:'
su -c 'pm2 jlist' bots 2>/dev/null | python3 -c \"
import json,sys
for p in json.load(sys.stdin):
    e = p['pm2_env']
    print('    %-16s %-8s reinicios=%s  uptime=%s min' % (p['name'], e['status'], e['restart_time'], round((__import__('time').time()*1000 - e.get('pm_uptime',0))/60000)))
\" 2>/dev/null"

# ---------------------------------------------------------------------------
titulo "Claves en los logs"
# ---------------------------------------------------------------------------
# Un log con una clave adentro es una clave filtrada: los logs se copian, se
# pegan en un ticket y se mandan por correo.
ssh_do "cd $APP/logs 2>/dev/null || exit 0
enc=0
for pat in 'eyJhbGciOi' 'sk-or-v1' 'service_role'; do
  n=\$(grep -rl \"\$pat\" . 2>/dev/null | wc -l)
  [ \"\$n\" -gt 0 ] && { echo \"  MAL  '\$pat' aparece en \$n archivo(s) de log\"; enc=1; }
done
[ \$enc -eq 0 ] && echo '  ok   ninguna clave en los logs'
echo \"  peso total de los logs: \$(du -sh . 2>/dev/null | cut -f1)\"
echo \"  rotacion configurada:\"
su -c 'pm2 conf pm2-logrotate' bots 2>/dev/null | grep -E 'max_size|retain' | sed 's/^/    /' || echo '    pm2-logrotate NO instalado'"

printf '\n\033[36m==> Listo\033[0m\n'
