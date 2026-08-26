# Marca

Acá se dejan los archivos de identidad tal como llegan. Es una **bandeja de
entrada**, no la carpeta que sirve el panel: de acá los tomamos, los limpiamos y
los dejamos en `platform/panel/public/` en el formato y el tamaño que el front
necesita. Nadie tiene que preocuparse por optimizar nada antes de soltarlo.

Si no sabés en qué subcarpeta va algo, tirálo suelto en la raíz de `marca/` y lo
acomodamos.

## Qué va en cada carpeta

### `logos/`

Marcas, en el mejor formato que exista. El orden de preferencia es
**SVG → PDF/EPS/AI → PNG con fondo transparente → JPG**. Un SVG del logo vale más
que diez PNG, porque se puede recolorear, escalar y meter dentro del HTML sin
pedirle un archivo más al navegador.

Lo que sirve tener:

- Logo de la **Municipalidad de San Miguel de Tucumán**, en todas sus variantes:
  color, monocromo, versión para fondo oscuro, versión horizontal y compacta.
- Logo o isotipo de la **Dirección de Ambiente**, si el área tiene el suyo.
- El **personaje o avatar de Migue**, si existe alguno del bot anterior.
- Cualquier sello, escudo o firma visual que tenga que aparecer en un pie.

### `tipografias/`

Sólo si el municipio usa tipografías propias o licenciadas. Formatos: `.woff2`
(el que sirve el navegador), `.otf` o `.ttf`.

Hoy el panel carga **Archivo** y **Asap** desde Google Fonts, elegidas a ojo. Si
las oficiales son otras, las cambiamos; y en cualquier caso conviene dejar de
depender de Google Fonts y servirlas desde la VPS.

### `fotos/`

Fotos institucionales reales del área. Sirven para dos cosas distintas:

- **Para el panel**: la pantalla de ingreso, cabeceras, estados vacíos.
- **Para lo que Migue le manda al vecino**: una foto de un Punto Verde, cómo hay
  que dejar los residuos en la vereda, el camión de retiro. Una imagen resuelve
  en un segundo lo que tres párrafos explican mal.

Cuanto más grandes vengan, mejor: recortar es fácil, inventar píxeles no.

### `referencias/`

Todo lo que sirve para mirar y decidir, aunque no se use directamente:

- **Manual de marca / normas gráficas** del municipio (PDF). Es el archivo más
  valioso de todos: fija los colores exactos, las tipografías y los usos
  prohibidos, y nos evita adivinar.
- **Capturas del bot anterior** en ManyChat: qué ve hoy el vecino.
- **Capturas de otros sistemas del municipio**, para que el panel no parezca de
  otra ciudad.
- Flyers, placas de redes y piezas de comunicación del área.

### `originales/`

Los archivos pesados de diseño: `.ai`, `.psd`, `.eps`, PDFs de imprenta, fotos
sin procesar. **Esta carpeta no se versiona** (está en `.gitignore`), igual que
`corpus/`: git no maneja bien los binarios grandes y no queremos un repositorio
de 300 MB. Vive en tu máquina y en el disco del área.

## De dónde sale el color que se usa hoy

Los tres colores institucionales del panel se **muestrearon del logo real**, no
salieron de un manual:

- `#0066FF` azul · `#2EB1FF` celeste · `#F4DC00` amarillo · `#333333` gris

Si el manual de marca dice otra cosa, manda el manual.

## Qué se está usando hoy

De esta carpeta salen tres archivos que el panel sirve desde
`platform/panel/public/marca/` y `platform/panel/src/app/`:

| De acá | Va a | Dónde se ve |
|---|---|---|
| `logos/muni.png` | `src/app/icon.png`, `apple-icon.png`, `public/marca/muni.png` | Pestaña del navegador y pantalla de ingreso |
| `logos/logo-dia.png` | `public/marca/dia-sobre-oscuro.png` | Crédito «Desarrollado por» al pie de la barra |
| `fotos/migue-ambiente-fondo.png` | `public/marca/migue.webp` | Portada del panel |

Los archivos que sirve el panel se **generan** a partir de estos: se recortan,
se escalan y en el caso del logo de la DIA se le aclara el texto gris, que sobre
el verde profundo de la barra quedaba en 3,2:1 de contraste. No se editan a
mano — si cambia un original, se vuelven a generar.

**Un aprendizaje sobre los recortes**: `migue-ambiente.jpeg` tenía fondo blanco
y hubo que recortarlo a mano; `migue-ambiente-fondo.png` ya viene con canal alfa
y salió mucho mejor. Cuando pidas una ilustración, pedíla **en PNG con fondo
transparente**: ahorra el recorte y no deja orla.

## Lo que todavía falta

- **Logo de la Secretaría de Ambiente y Desarrollo Sustentable.** No existe
  todavía. Su lugar en la barra está ocupado por el nombre en tipografía y por
  el verde de toda la interfaz.
- **Manual de marca del municipio.** Los colores institucionales están
  muestreados del logo, no leídos de un documento.
- **Tipografías oficiales.** Hoy el panel usa Archivo y Asap desde Google Fonts.
