-- ===========================================================================
-- 030 · El tipo de cambio, editable
-- ===========================================================================
-- El costo de la IA llega de OpenRouter en dólares y así se guarda en
-- `mensajes.costo_usd`. Pero quien mira el tablero presupuesta en pesos, y
-- «US$ 0,39» no le dice si eso es mucho o poco para un municipio.
--
-- La conversión NO se hace en el código con un número escrito adentro. Un tipo
-- de cambio hardcodeado en Argentina queda viejo en semanas, y lo peor no es
-- que quede viejo: es que el panel seguiría mostrando pesos con toda confianza,
-- sin decir de cuándo son. Acá es una fila que el área edita, y el tablero
-- muestra SIEMPRE al lado la cotización usada y desde cuándo está cargada.
--
-- Arranca en 0, que significa «nadie la cargó». Con 0 el tablero no muestra
-- pesos: muestra un enlace para cargarla. Sembrarla con un valor inventado
-- sería peor que no tenerla, porque nadie sabría que es inventado.
--
-- Es la única clave de `configuracion` que NO cambia nada de lo que recibe el
-- vecino: sólo afecta cómo se lee el tablero. Por eso su categoría es 'panel' y
-- no 'negocio'.
-- ===========================================================================

insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('tipo_cambio_usd_ars', '0'::jsonb,
   'Pesos por dólar, para mostrar el costo de la IA en moneda local. 0 = sin cargar: el tablero no convierte y pide que se cargue. No afecta nada de lo que recibe el vecino.',
   'panel')
on conflict (clave) do nothing;
