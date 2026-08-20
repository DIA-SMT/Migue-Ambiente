# Herramientas de ingesta

Scripts que se corren a mano. No son tests: los tests verifican reglas, esto
mira qué le pasa a los documentos de verdad.

Todos se corren **desde la raíz del paquete** (`platform/packages/migue-dominio`).

## `medir-ingesta.mjs`

Pasa todo el corpus local por el extractor y el fragmentador, y muestra cuántos
fragmentos salen, de qué tamaño y con qué secciones. Correlo cada vez que toques
algo de `src/ingesta/`.

```bash
node herramientas/medir-ingesta.mjs
```

Con `--detalle` imprime el texto de cada fragmento, que es la única forma de ver
si los cortes caen donde tienen que caer.

Además falla con código distinto de cero si detecta algo que nunca debería
pasar: una marca de título filtrada al texto guardado, un índice indexado, o el
orden de los fragmentos con huecos.

## `preparar-storage.mjs`

Crea el bucket de Storage y sube el corpus inicial, registrando cada documento
y encolando su ingesta. Es para la carga del primer día; después los documentos
se suben desde el panel.

```bash
node --env-file=../../../../.env.local herramientas/preparar-storage.mjs            # ensayo
node --env-file=../../../../.env.local herramientas/preparar-storage.mjs --aplicar
```

Es idempotente: se apoya en el hash del contenido, así que correrlo dos veces no
duplica nada.

## `estado.mjs`

Sólo lee. Muestra en qué estado quedó cada documento, cómo está la cola y si
falta aplicar la migración 016.

```bash
node --env-file=../../../../.env.local herramientas/estado.mjs
```

## `reindexar.mjs`

Limpia los trabajos terminados de la cola y vuelve a encolar la indexación de
todos los documentos activos. Es lo que se corre después de mejorar el
fragmentador o de corregir un bug de extracción: los archivos ya están en el
Storage, sólo hay que volver a leerlos.

```bash
node --env-file=../../../../.env.local herramientas/reindexar.mjs
```

## `probar-busqueda.mjs`

Corre `buscar_conocimiento` contra lo que está indexado y muestra qué material
encontraría Migue, sin llamar al modelo. Con eso se ve si una pregunta tiene
respuesta en el corpus o si el bot va a tener que admitir que no sabe.

```bash
node --env-file=../../../../.env.local herramientas/probar-busqueda.mjs
node --env-file=../../../../.env.local herramientas/probar-busqueda.mjs "mi pregunta"
```

Sin argumentos corre una batería fija que incluye dos controles negativos
—preguntas de otra área— para ver si el buscador trae ruido.

## `ver-config.mjs`

Lista todo lo que se puede cambiar hoy sin tocar código: las claves de
`configuracion`, los mensajes de `textos_bot` con sus marcadores, y cuántas FAQs
y respuestas fijas hay cargadas. Es el inventario de lo que el panel va a
administrar.

```bash
node --env-file=../../../../.env.local herramientas/ver-config.mjs
```

## Diagnósticos puntuales

`diag-hash.mjs` compara el hash guardado en `documentos` con el hash real del
archivo en el Storage. `diag-buffer.mjs` comprueba si una librería de extracción
se apropia del buffer que recibe. Los dos se escribieron para encontrar bugs
concretos y se dejan porque el problema puede volver al cambiar de versión de
`pdfjs`.

