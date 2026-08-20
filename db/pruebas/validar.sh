#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Valida el esquema completo contra una base desechable en la VPS.
#
# NUNCA toca Supabase. Crea y destruye `migue_prueba` en el Postgres local.
# Corre las migraciones tres veces para probar idempotencia, y después las
# pruebas funcionales.
#
#   bash db/pruebas/validar.sh
# ---------------------------------------------------------------------------
set -euo pipefail

VPS_HOST="${VPS_HOST:-195.35.42.168}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/multibot_vps}"
DB="${DB:-migue_prueba}"

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ssh_do() {
  ssh -i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes "root@$VPS_HOST" "$@"
}

echo "==> Subiendo esquema y pruebas"
tar -C "$DB_DIR" -czf - migraciones pruebas \
  | ssh_do "rm -rf /tmp/dbtest && mkdir -p /tmp/dbtest && tar -C /tmp/dbtest -xzf -"

echo "==> Recreando base desechable '$DB'"
ssh_do "sudo -u postgres psql -q -c \"drop database if exists $DB\" -c \"create database $DB\" >/dev/null 2>&1
        sudo -u postgres psql -q -f /tmp/dbtest/pruebas/roles_supabase.sql >/dev/null 2>&1"

echo "==> Aplicando migraciones (3 pasadas, para probar idempotencia)"
ssh_do "cd /tmp/dbtest
  for pasada in 1 2 3; do
    printf '    pasada %s: ' \$pasada
    fallos=0
    for f in pruebas/000_stub_tablas_legado.sql migraciones/*.sql; do
      # El estado que importa es el de psql. Filtrar NOTICE con grep acá
      # rompería la detección: grep devuelve 1 cuando no queda ninguna línea.
      if out=\$(sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d $DB -f \"\$f\" 2>&1); then
        :
      else
        echo; echo \"      FALLO en \$(basename \$f):\"
        printf '%s\n' \"\$out\" | grep -v NOTICE | head -5
        fallos=1
      fi
    done
    [ \$fallos -eq 0 ] && echo 'OK'
  done"

echo "==> Pruebas funcionales"
# El filtro incluye 'psql:' y 'CONTEXT' a propósito: sin eso, un RAISE EXCEPTION
# de una prueba queda invisible y el script parece haber pasado.
ssh_do "cd /tmp/dbtest && sudo -u postgres psql -q -d $DB -f pruebas/010_pruebas_funcionales.sql 2>&1 \
        | grep -E '^(==|   OK|ERROR|FATAL|psql:|CONTEXT|=====| TODAS)'" || {
  echo "    LAS PRUEBAS FUNCIONALES FALLARON"
  exit 1
}

echo "==> Auditoría de RLS (debe devolver cero filas)"
ssh_do "sudo -u postgres psql -qtA -d $DB \
        -c \"select tabla from public.v_auditoria_rls where rls_activo = false or 'anon' = any(roles_con_acceso)\"" \
  | sed 's/^/    PROBLEMA: /' || true

echo "==> Listo"
