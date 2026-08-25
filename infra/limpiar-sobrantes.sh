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
#
# CÓMO COMPROBAR QUE UNA RUTA SE FUE DE VERDAD
#
# No sirve pedirla por HTTP. El proxy del panel intercepta todo lo que no está
# en su lista pública y devuelve 307 hacia el login, así que una ruta borrada y
# una ruta inexistente dan lo MISMO que una ruta que sigue ahí. Ya me confundió
# dos veces: leí un 307 como «no existe» y la ruta estaba viva.
#
# La comprobación real es el manifiesto del build en el servidor:
#
#   ssh ... "cd /srv/bots/panel && python3 -c \"
#     import json; print(sorted(json.load(open('.next/app-path-routes-manifest.json'))))\""
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

# ---------------------------------------------------------------------------
# Y las carpetas que quedaron vacías.
#
# Borrar los archivos no borra el directorio, y en el App Router de Next un
# directorio es una RUTA. Quedaron tres así durante muchos deploys:
# `app/faqs`, `app/textos` y `app/auth/callback` — esta última es la del magic
# link, que se eliminó del repo hace tiempo.
#
# Hoy son inocuas: sin `page.tsx` adentro, Next no genera ninguna ruta, y el
# manifiesto del build lo confirma. Pero es exactamente la clase de sobrante que
# ya tiró el panel abajo una vez: `middleware.ts` renombrado a `proxy.ts`
# convivieron en la VPS y Next 16 se niega a compilar con los dos. Un directorio
# vacío de hoy es el que mañana recibe un archivo con el mismo nombre.
#
# El bucle corre hasta que no queda ninguna, porque borrar la hoja deja vacío al
# padre: `auth/callback` primero, y en la pasada siguiente `auth`.
vacias=0
if [[ $SIMULAR -eq 1 ]]; then
  find "${CARPETAS[@]}" -mindepth 1 -type d -empty -not -path '*/node_modules/*' -not -path '*/.next/*' \
    -print 2>/dev/null | sed 's|^|    sobraría la carpeta: |'
else
  # `-mindepth 1` protege a las carpetas RAÍZ. Sin eso, si `packages` quedara
  # vacía se borraba entera, y en la pasada siguiente `find` fallaba por ruta
  # inexistente: con `set -e` el script moría justo antes de informar lo que
  # había hecho. Y borrar una raíz nunca es lo correcto — el tar siempre las
  # trae.
  #
  # Se repite hasta que no queda ninguna: borrar la hoja deja vacío al padre.
  #
  # Y se cuentan las que se BORRARON, no las que se habían encontrado antes de
  # borrar. `find -delete` es depth-first y colapsa el anidado en la MISMA
  # pasada: borra `auth/callback` y en el mismo recorrido ve `auth` ya vacío y
  # lo borra también. Contando de antes, la primera versión de esto informó
  # «3 carpetas» habiendo borrado 4 — un número que no dice lo que parece, que
  # es justo lo que este proyecto viene corrigiendo en otras cinco partes.
  while :; do
    borradas=$(find "${CARPETAS[@]}" -mindepth 1 -type d -empty -not -path '*/node_modules/*' -not -path '*/.next/*' \
      -print -delete 2>/dev/null)
    [[ -z "$borradas" ]] && break
    printf '%s\n' "$borradas" | sed 's|^|    carpeta vacía borrada: |'
    vacias=$((vacias + $(printf '%s\n' "$borradas" | wc -l)))
  done
fi
# Un `if` y no `[[ ... ]] && echo`: con `set -e`, un test que da falso en la
# ÚLTIMA línea hace salir al script con estado 1, y `deploy.sh` lo leería como
# una falla de limpieza. Es el mismo error de estado de salida que ya hizo que un
# build roto reportara «build ok».
if [[ $vacias -gt 0 ]]; then
  echo "    $vacias carpeta(s) vacía(s) borradas"
fi
