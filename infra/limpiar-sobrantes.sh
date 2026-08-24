#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# limpiar-sobrantes.sh — borra en la VPS los archivos de código que ya no
# existen en el repo.
#
# Lo corre `deploy.sh` en el servidor, después de extraer el tar. NO se corre a
# mano.
#
# POR QUÉ EXISTE
#
# `tar -x` sobre un árbol existente nunca borra: un archivo renombrado o
# eliminado en el repo queda para siempre en el servidor. Eso tiró el panel
# abajo una vez —`middleware.ts` se renombró a `proxy.ts`, quedaron los dos en
# la VPS, y Next 16 se niega a compilar con ambos— así que `next start` arrancaba
# sin build y nginx devolvía 502.
#
# CÓMO
#
# Recibe por argumento un manifiesto: la lista de rutas que SÍ tiene el repo,
# generada del propio tar antes de subirlo. Todo archivo de código que esté en
# disco y no en el manifiesto se borra.
#
# Es un archivo aparte y no un heredoc dentro de un `ssh` a propósito: acá se
# ejecuta `rm`, y las comillas anidadas entre el shell local y el remoto son una
# fuente de errores que en este caso costaría datos.
#
#   bash limpiar-sobrantes.sh <raiz> <manifiesto> [--simular]
# ---------------------------------------------------------------------------
set -euo pipefail

RAIZ="${1:?falta la raiz}"
MANIFIESTO="${2:?falta el manifiesto}"
SIMULAR=0
[[ "${3:-}" == "--simular" ]] && SIMULAR=1

[[ -d "$RAIZ" ]] || { echo "    no existe $RAIZ" >&2; exit 1; }
[[ -s "$MANIFIESTO" ]] || { echo "    el manifiesto está vacío; no borro nada" >&2; exit 1; }

cd "$RAIZ"

# Sólo las carpetas de código que viajan en el tar. node_modules, .next y logs
# NO viajan, así que compararlos contra el manifiesto los borraría todos.
CARPETAS=()
for c in bots packages panel scripts; do
  [[ -d "$c" ]] && CARPETAS+=("$c")
done
[[ ${#CARPETAS[@]} -gt 0 ]] || { echo "    no hay carpetas de código"; exit 0; }

borrados=0

# `-print0` y `read -d ''` para tolerar nombres con espacios, que en este
# proyecto existen: hay documentos con espacios y acentos en el nombre.
while IFS= read -r -d '' ruta; do
  limpia="${ruta#./}"
  if ! grep -qxF "$limpia" "$MANIFIESTO"; then
    if [[ $SIMULAR -eq 1 ]]; then
      echo "    sobraría: $limpia"
    else
      rm -f "$limpia"
      echo "    borrado: $limpia"
    fi
    borrados=$((borrados + 1))
  fi
done < <(
  find "${CARPETAS[@]}" -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) \
    -not -path '*/node_modules/*' \
    -not -path '*/.next/*' \
    -not -name 'next-env.d.ts' \
    -print0
)

if [[ $borrados -eq 0 ]]; then
  echo "    nada que borrar"
elif [[ $SIMULAR -eq 1 ]]; then
  echo "    $borrados archivo(s) sobrarían (simulación: no se borró nada)"
else
  echo "    $borrados archivo(s) borrados"
fi
