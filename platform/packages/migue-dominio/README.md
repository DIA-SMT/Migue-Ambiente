# `@migue/dominio`

Lógica de negocio de Migue Ambiente. **96 tests, 0 fallos** — 83 unitarios más
13 de integración contra la Supabase real. Verificado en Node 25 (local) y
22.23 (producción).

```bash
pnpm test        # node --test, descubrimiento automático
pnpm typecheck   # tsc --noEmit, strict completo
```

Los tests de integración se saltean solos si no hay credenciales, así la suite
corre en cualquier máquina. Para ejecutarlos, en la VPS:

```bash
cd /srv/bots/packages/migue-dominio
set -a; . /srv/bots/.secrets/migue.env; set +a
node --test
```

## Dos reglas que atraviesan todo el paquete

**No conoce ningún canal.** No importa grammY, ni Telegram, ni WhatsApp. Eso es
lo que permitirá sumar WhatsApp escribiendo sólo un adaptador, sin tocar reglas
ni flujos.

**No decide textos.** Cada mensaje al vecino sale de `textos_bot`. Si un
operador necesita esperar un deploy para corregir una redacción, el sistema
falló.

## Módulos

| Módulo | Qué resuelve |
|---|---|
| `texto.ts` | Normalización y coincidencia por palabra completa |
| `reglas/exclusiones.ts` | Derivaciones: gas, SAT, alumbrado, arbolado, neumáticos |
| `reglas/cantidad.ts` | Interpreta la cantidad declarada en texto libre |
| `reglas/volumen.ts` | Decide si el pedido entra en el servicio gratuito |
| `reglas/sla.ts` | Calcula el plazo que el bot le promete al vecino |
| `datos/cliente.ts` | Cliente de Supabase con la clave de servicio |
| `datos/cache.ts` | Caché con vencimiento y coalescencia de cargas |
| `datos/catalogo.ts` | Todo lo administrable, cargado y cacheado junto |

## El catálogo

`obtenerCatalogo()` trae de una sola vez las seis colecciones que un operador
puede editar: configuración, textos, reglas de exclusión, límites, Puntos Verdes
y zonas.

Se carga entero en vez de repositorio por repositorio porque el bot necesita
casi todo en el mismo mensaje: para responder «tengo 8 bolsas de escombros»
hacen falta las reglas, los límites, los textos y la configuración. Seis
consultas cacheadas juntas cuestan un viaje por minuto; seis cachés
independientes vencen en momentos distintos y pueden dejar al bot decidiendo con
una mezcla de datos viejos y nuevos.

**TTL de 60 segundos.** Es lo que hace que una edición del panel llegue a
producción sin reiniciar nada: el operador corrige un texto y en menos de un
minuto está en el aire.

Tres decisiones del caché que vale conocer:

- **Coalescencia de cargas.** Veinte mensajes simultáneos disparan **una** sola
  consulta, no veinte. Hay un test que lo verifica con veinte llamadas en
  paralelo.
- **Sirve el valor viejo si la recarga falla.** Ante una caída momentánea de
  Supabase, responder con reglas de hace dos minutos es mejor que dejar de
  responderle a los vecinos. Pero no refresca el reloj: cada pedido reintenta.
- **Los `numeric` se convierten a número.** Postgres devuelve `numeric` como
  string para no perder precisión. Sin ese `Number()`, la comparación de
  límites sería lexicográfica y `"10" < "5"` daría verdadero. Hay un test de
  integración que lo verifica contra el esquema desplegado, porque ningún mock
  puede detectarlo.

Un texto que falta devuelve `[falta texto: clave]` y no cadena vacía: un mensaje
vacío al vecino es un error silencioso, el marcador se ve en la primera prueba.

## Decisiones que conviene conocer

### Coincidencia por palabra completa, no por substring

La regla de gas tiene cargada la palabra `gas`. Con coincidencia por substring,
**«cuánto gasto en bolsas» derivaría al vecino a Naturgy**. También «pagas»,
«gaseosa» y «gasoil».

`contienePalabra()` usa límites de palabra y acepta el plural español (`pila`
agarra `pilas`), así el operador carga la forma singular y no una lista de
variantes. Hay tests explícitos para cada falso positivo.

### La normalización tiene que coincidir con Postgres

`normalizar()` replica lo que hace la configuración `es_sin_acentos` de la base:
minúsculas, sin tildes, `ñ`→`n`. Si las dos puntas normalizaran distinto, una
regla que coincide en el motor no coincidiría en la búsqueda, y el bot se
comportaría de forma inconsistente sin razón visible.

Dos casos que costaron un bug cada uno:

- **`m³` se convierte a `m3`.** Los superíndices son categoría *Number* en
  Unicode y sobreviven al filtro de puntuación, así que `m³` quedaba distinto de
  `m3` y el parser no los reconocía como la misma unidad.
- **El separador decimal se preserva entre dígitos.** Barrer toda la puntuación
  partía `0,2 m3` en los tokens `0` y `2`, y el resultado se leía como el
  **rango 0 a 2**. Ahora un punto o coma entre dígitos sobrevive; el punto de
  final de oración sigue barriéndose.

### Ante la duda, preguntar

`validarVolumen()` devuelve tres cosas: `dentro`, `excede` o `precisar`. Un
`dentro` equivocado le promete al vecino un retiro que no va a pasar y manda un
camión al lugar equivocado; un `excede` equivocado le niega un servicio al que
tiene derecho. Una pregunta más cuesta mucho menos que cualquiera de las dos.

Se pide precisión cuando la cantidad es vaga, cuando un rango cruza el límite,
cuando la unidad no se puede convertir con honestidad, y cuando una conversión
cae a menos de 25% del límite —ahí el factor aproximado no alcanza para decidir.

La conversión bolsa↔m³ usa **0,04 m³ por bolsa**, que es una aproximación
operativa, no una medida. Por eso existe el margen de duda.

Los muebles y objetos contados por unidad **nunca deciden solos**: no hay factor
honesto entre «tres sillas» y un metro cúbico. Siempre se pregunta.

Y una pregunta, no un cuestionario: `preguntaParaPrecisar()` devuelve una sola,
con el límite mencionado para que el vecino sepa contra qué se mide. La crítica
central del QA al bot anterior era que preguntaba de más antes de dar
información.

### El precedente número-sobre-adjetivo

`«muchas, unas 12 bolsas»` son **12**, no «mucho»: un número concreto le gana a
un adjetivo. Pero `«es mucho, un camión»` es **«mucho»**, no 1 — el «un» de «un
camión» no es una cantidad. La vaguedad se evalúa antes de recurrir a números
sueltos justamente por ese caso.

### El plazo: un bug heredado

El bot anterior calculaba el vencimiento como *creado + 72 horas corridas*. Un
ticket creado el jueves 12/02/2026 quedó con vencimiento el **domingo 15/02**,
para un servicio que la spec describe como «72 horas hábiles».

«72 horas hábiles» admite tres lecturas y entre ellas hay diez días de
diferencia:

| Modo | Resultado desde ese jueves |
|---|---|
| `dias_habiles` (default) | lunes 16/02 |
| `horas_corridas` | domingo 15/02 — lo que hacía el bot anterior |
| `horas_habiles` | miércoles 25/02 |

El default es `dias_habiles` porque en el uso administrativo argentino «72
horas hábiles» se entiende como tres días hábiles, y porque es la única de las
tres que da un plazo razonable para retirar residuos. **La decisión es de
Ambiente**; el modo está en `configuracion`.

Dos parámetros que no son obvios:

- **El sábado es hábil por defecto.** La recolección de Zona Sur trabaja los
  sábados según el anexo de la spec. Es distinto del calendario administrativo,
  y por eso es un parámetro y no una constante.
- **El offset horario es una constante `-3`, no `Intl`.** Argentina no aplica
  horario de verano desde 2009. Una constante explícita es más fácil de auditar
  y no depende de que la base de zonas del sistema esté actualizada.

Hay un test de barrido que verifica que, partiendo de cualquier día de la
semana y con cualquier configuración de sábado, **el vencimiento nunca cae en
día inhábil**.

## Secretos

Viven en `/srv/bots/.secrets/migue.env` (permisos 600, dueño `bots`), fuera del
repositorio. La `SERVICE_ROLE` pasa por encima de RLS: da lectura y escritura
sobre toda la base, incluidos los datos personales de vecinos. **No debe llegar
al panel ni al navegador** — el panel usa la clave anónima más Supabase Auth, y
RLS es lo que lo limita a lo que el personal municipal puede ver.

## Pendiente en este paquete

- `datos/conversaciones.ts`, `datos/tickets.ts`, `datos/sinRespuesta.ts` —
  escritura de la traza y de los pedidos.
- `flujos/` — máquina de estados de los flujos A a D (fase 4).
