-- ===========================================================================
-- 012 · Referencia de foto separada de la URL final
-- ===========================================================================
-- El flujo captura un `file_id` de Telegram, que NO es una URL: es un
-- identificador que sólo sirve contra la API del canal de origen. El worker lo
-- descarga después y lo sube a Supabase Storage, y ahí sí hay URL.
--
-- Reutilizar `photo_url` para las dos cosas dejaría al panel sin saber si el
-- valor que tiene es algo que puede mostrar o algo que todavía no se procesó.
-- Con dos columnas la respuesta es obvia: si `photo_url` está en null y
-- `photo_ref` no, la foto está en camino.
-- ===========================================================================

alter table public.tickets
  add column if not exists photo_ref text;

comment on column public.tickets.photo_ref is
  'Referencia del archivo en el canal de origen (file_id de Telegram). El worker la resuelve y llena photo_url.';
comment on column public.tickets.photo_url is
  'URL pública en Supabase Storage. Null mientras el worker no haya descargado la foto.';

-- Permite al worker encontrar rápido lo que le falta procesar.
create index if not exists tickets_foto_pendiente_idx
  on public.tickets (created_at)
  where photo_ref is not null and photo_url is null;

alter table public.program_requests
  add column if not exists photo_ref text,
  add column if not exists photo_url text;

comment on column public.program_requests.photo_ref is
  'Referencia del archivo en el canal de origen. Aplica sobre todo a TRANSFORMÁ (fotos de relevamiento) y SEPARÁ.';

-- ---------------------------------------------------------------------------
-- Ventana de conversación
-- ---------------------------------------------------------------------------
-- Si un vecino escribe de nuevo tres días después, no es la misma
-- conversación: reutilizarla mezclaría dos consultas distintas en un mismo
-- hilo y falsearía las métricas de duración y de mensajes por conversación.
insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('conversacion_ventana_horas', '24'::jsonb,
   'Horas de inactividad tras las que una conversación abierta se considera terminada y el próximo mensaje abre una nueva.',
   'negocio')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- Tipo de trabajo para descargar media de un canal
-- ---------------------------------------------------------------------------
-- Usar `ingestar_documento` para bajar la foto de un vecino sería mentirle al
-- panel: son dos cosas distintas con prioridades distintas. Detrás de una foto
-- hay alguien esperando respuesta; detrás de un PDF del panel no.
alter table public.trabajos drop constraint if exists trabajos_tipo_check;
alter table public.trabajos
  add constraint trabajos_tipo_check check (tipo in (
    'ingestar_documento',
    'reindexar_documento',
    'borrar_documento',
    'reindexar_todo',
    'descargar_media'
  ));
