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
