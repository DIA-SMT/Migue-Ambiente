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

# El archivo combinado actual, para la prueba de actualización de más abajo.
scp -q -i "$SSH_KEY" -o BatchMode=yes "$DB_DIR/aplicar_todo.sql" \
    "root@$VPS_HOST:/tmp/aplicar_todo_actual.sql"

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

# ---------------------------------------------------------------------------
# Prueba de ACTUALIZACIÓN
# ---------------------------------------------------------------------------
# El resto del arnés aplica el esquema sobre una base nueva, así que nunca hay
# una versión anterior con la que chocar. Eso dejó pasar un error a producción:
# `create or replace function` con una firma distinta NO reemplaza, crea una
# sobrecarga, y quedan dos funciones con el mismo nombre.
#
# Esta pasada aplica la última versión commiteada y encima la actual, que es
# exactamente lo que hace el operador al pegar el SQL en Supabase.
# ---------------------------------------------------------------------------
if git -C "$DB_DIR/.." show HEAD:db/aplicar_todo.sql > /tmp/esquema_anterior.sql 2>/dev/null; then
  echo "==> Prueba de actualización: versión commiteada → versión actual"

  scp -q -i "$SSH_KEY" -o BatchMode=yes /tmp/esquema_anterior.sql \
      "root@$VPS_HOST:/tmp/esquema_anterior.sql"
  rm -f /tmp/esquema_anterior.sql

  ssh_do "sudo -u postgres psql -q -c 'drop database if exists ${DB}_upg' -c 'create database ${DB}_upg' >/dev/null 2>&1
    sudo -u postgres psql -q -d ${DB}_upg -f /tmp/dbtest/pruebas/000_stub_tablas_legado.sql >/dev/null 2>&1

    printf '    versión anterior: '
    if sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d ${DB}_upg -f /tmp/esquema_anterior.sql >/tmp/upg1.log 2>&1; then
      echo 'aplicada'
    else
      echo 'FALLÓ'; grep -v NOTICE /tmp/upg1.log | head -5
    fi

    printf '    versión actual encima: '
    if sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d ${DB}_upg -f /tmp/aplicar_todo_actual.sql >/tmp/upg2.log 2>&1; then
      echo 'aplicada'
    else
      echo 'FALLÓ'; grep -v NOTICE /tmp/upg2.log | head -8
    fi

    printf '    funciones duplicadas: '
    # Se excluyen las que pertenecen a una extensión (deptype='e'): pgcrypto y
    # pg_trgm tienen sobrecargas legítimas, y no son nuestras.
    dup=\$(sudo -u postgres psql -qtA -d ${DB}_upg -c \"select p.proname || ' (' || count(*) || ')' from pg_proc p where p.pronamespace = 'public'::regnamespace and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') group by p.proname having count(*) > 1\")
    if [ -z \"\$dup\" ]; then echo 'ninguna'; else echo \"SOBRECARGAS PROPIAS: \$dup\"; fi

    sudo -u postgres psql -q -c 'drop database if exists ${DB}_upg' >/dev/null 2>&1"
fi

echo "==> Auditoría de RLS (debe devolver cero filas)"
ssh_do "sudo -u postgres psql -qtA -d $DB \
        -c \"select tabla from public.v_auditoria_rls where rls_activo = false or 'anon' = any(roles_con_acceso)\"" \
  | sed 's/^/    PROBLEMA: /' || true

echo "==> Listo"
