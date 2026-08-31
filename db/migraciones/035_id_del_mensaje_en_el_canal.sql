-- ---------------------------------------------------------------------------
-- 035 · El id que trae el canal, para no atender dos veces el mismo mensaje
--
-- POR QUÉ APARECE RECIÉN AHORA. Con Telegram no hacía falta. El bot usa long
-- polling: pregunta si hay algo nuevo, Telegram se lo da una sola vez y listo.
--
-- WhatsApp Cloud API funciona al revés: Meta nos hace un POST y espera un 200
-- en unos pocos segundos. Si no llega —porque el proceso estaba reiniciando,
-- porque hubo un hipo de red, porque tardamos— REINTENTA el mismo mensaje. El
-- reintento trae el mismo `wamid`.
--
-- QUÉ PASA SI NO SE DEDUPLICA. El mensaje se procesa dos veces: el vecino
-- recibe la respuesta repetida y, si estaba en el flujo de retiro, se le crea
-- un segundo ticket. Dos camiones al mismo domicilio. Es el tipo de falla que
-- no se ve en las pruebas —los reintentos aparecen bajo carga o después de un
-- deploy— y que en producción es cara.
--
-- POR QUÉ LA CLAVE ES (conversacion_id, canal_mensaje_id) Y NO EL ID SOLO. El
-- `wamid` es único en todo WhatsApp, pero `mensajes` no guarda el canal —está
-- en `conversaciones`— y otros canales no prometen ids únicos entre sí. Un
-- reintento siempre resuelve a la misma conversación, porque la conversación se
-- busca por (canal, canal_usuario_id) antes de escribir el mensaje. Así que
-- este par alcanza para el caso real y no puede chocar entre canales.
--
-- El índice es PARCIAL: los salientes y todo lo que ya está en la tabla tienen
-- la columna en null, y en Postgres los null no chocan entre sí. Sin el `where`
-- el índice cargaría con filas que no aportan nada.
--
-- QUÉ NO HACE ESTA MIGRACIÓN. Todavía nada escribe esta columna: el adaptador
-- de WhatsApp no existe. Se agrega ahora porque es la pieza de la que depende
-- que el webhook se pueda encender sin riesgo, y porque un `alter table` sobre
-- una tabla chica es gratis hoy y no lo es más adelante.
--
-- Idempotente.
-- ---------------------------------------------------------------------------

alter table public.mensajes
  add column if not exists canal_mensaje_id text;

comment on column public.mensajes.canal_mensaje_id is
  'Id del mensaje EN EL CANAL de origen (el «wamid» en WhatsApp). Sirve para descartar los reintentos del webhook: Meta reenvia el mismo mensaje si no recibe el 200 a tiempo, y procesarlo dos veces duplica el ticket. Null en los salientes y en todo lo anterior a WhatsApp.';

create unique index if not exists mensajes_canal_mensaje_idx
  on public.mensajes (conversacion_id, canal_mensaje_id)
  where canal_mensaje_id is not null;
