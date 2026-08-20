#!/usr/bin/env bash
# Regenera aplicar_todo.sql a partir de las migraciones individuales.
set -euo pipefail
cd "$(dirname "$0")"
{
  echo "-- ==========================================================================="
  echo "-- MIGUE AMBIENTE · esquema completo"
  echo "-- Generado por: cat migraciones/*.sql — NO editar este archivo."
  echo "-- Editá las migraciones individuales y regenerá con: bash generar_aplicar_todo.sh"
  echo "--"
  echo "-- Aplicar: pegar en el SQL Editor de Supabase y ejecutar."
  echo "-- Es idempotente: se puede correr varias veces sin romper nada."
  echo "-- ==========================================================================="
  echo
  for f in migraciones/*.sql; do
    echo; echo "-- >>>>>>>>>>>>>>>>>>>> $(basename "$f") <<<<<<<<<<<<<<<<<<<<"; echo
    cat "$f"
  done
} > aplicar_todo.sql
echo "aplicar_todo.sql regenerado ($(wc -l < aplicar_todo.sql) lineas)"
