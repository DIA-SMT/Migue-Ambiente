-- ===========================================================================
-- 002 · Base de conocimiento: documentos, fragmentos, FAQs, respuestas fijas
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Documentos subidos desde el panel (PDF / DOCX)
-- El archivo vive en Supabase Storage; acá va el metadato y el estado de
-- procesamiento, que es lo que el panel muestra mientras el worker trabaja.
-- ---------------------------------------------------------------------------
create table if not exists public.documentos (
  id             uuid primary key default gen_random_uuid(),
  titulo         text        not null,
  descripcion    text,
  nombre_archivo text        not null,
  formato        text        not null check (formato in ('pdf','docx','txt','md')),
  ruta_storage   text        not null unique,
  bytes          bigint      not null check (bytes > 0),
  hash_sha256    text,
  paginas        int,
  estado         text        not null default 'pendiente'
                   check (estado in ('pendiente','procesando','listo','error')),
  error_detalle  text,
  cantidad_fragmentos int    not null default 0,
  activo         boolean     not null default true,
  subido_por     uuid,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

drop trigger if exists documentos_tocar on public.documentos;
create trigger documentos_tocar before update on public.documentos
  for each row execute function public.tocar_actualizado_en();

-- Un mismo archivo subido dos veces no debe indexarse dos veces.
create unique index if not exists documentos_hash_unico
  on public.documentos (hash_sha256) where hash_sha256 is not null;

create index if not exists documentos_estado_idx on public.documentos (estado)
  where estado in ('pendiente','procesando');

comment on column public.documentos.activo is
  'Baja lógica: el panel lo oculta y el bot deja de citarlo, sin perder el historial.';

-- ---------------------------------------------------------------------------
-- Fragmentos indexados. Es la unidad que realmente se busca y se cita.
-- ---------------------------------------------------------------------------
create table if not exists public.fragmentos (
  id            uuid primary key default gen_random_uuid(),
  documento_id  uuid not null references public.documentos(id) on delete cascade,
  orden         int  not null,
  texto         text not null,
  pagina        int,
  titulo_seccion text,
  tokens_aprox  int,
  -- La columna generada mantiene el índice sincronizado sin trigger ni worker:
  -- es imposible que un fragmento quede indexado con texto viejo.
  busqueda      tsvector generated always as (
                  to_tsvector('public.es_sin_acentos', coalesce(titulo_seccion,'') || ' ' || texto)
                ) stored,
  creado_en     timestamptz not null default now(),
  unique (documento_id, orden)
);

create index if not exists fragmentos_busqueda_idx
  on public.fragmentos using gin (busqueda);
create index if not exists fragmentos_trigram_idx
  on public.fragmentos using gin (texto gin_trgm_ops);
create index if not exists fragmentos_documento_idx
  on public.fragmentos (documento_id);

-- ---------------------------------------------------------------------------
-- FAQs cargadas a mano desde el panel.
-- Participan de la búsqueda junto con los fragmentos, pero pesan más: una
-- respuesta escrita por un humano le gana a un pedazo de PDF.
-- ---------------------------------------------------------------------------
create table if not exists public.faqs (
  id            uuid primary key default gen_random_uuid(),
  pregunta      text not null,
  respuesta     text not null,
  etiquetas     text[] not null default '{}',
  prioridad     int  not null default 100,
  activa        boolean not null default true,
  veces_usada   int  not null default 0,
  -- Las etiquetas NO van acá: array_to_string() es STABLE, no IMMUTABLE, y
  -- Postgres rechaza la columna generada. Se indexan aparte con GIN sobre el
  -- array, que además da búsqueda exacta por etiqueta.
  -- setweight hace que la pregunta rankee por encima de la respuesta: si el
  -- vecino pregunta algo parecido a la pregunta de la FAQ, eso vale más que
  -- una coincidencia suelta en el cuerpo.
  busqueda      tsvector generated always as (
                  setweight(to_tsvector('public.es_sin_acentos', pregunta),  'A') ||
                  setweight(to_tsvector('public.es_sin_acentos', respuesta), 'B')
                ) stored,
  creada_por    uuid,
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

drop trigger if exists faqs_tocar on public.faqs;
create trigger faqs_tocar before update on public.faqs
  for each row execute function public.tocar_actualizado_en();

create index if not exists faqs_busqueda_idx on public.faqs using gin (busqueda);
create index if not exists faqs_pregunta_trigram_idx
  on public.faqs using gin (pregunta gin_trgm_ops);
-- Búsqueda por etiqueta: soporta etiquetas && array['puntos-verdes']
create index if not exists faqs_etiquetas_idx on public.faqs using gin (etiquetas);
create index if not exists faqs_activas_idx on public.faqs (activa, prioridad)
  where activa;

-- ---------------------------------------------------------------------------
-- Respuestas fijas: cortocircuito TOTAL del modelo.
--
-- Distintas de las FAQs a propósito. Una FAQ es material que el modelo lee
-- para redactar. Una respuesta fija se envía TEXTUAL, sin pasar por el modelo.
-- Es la herramienta para cuando la redacción institucional no es negociable
-- (plazos legales, montos, derivaciones formales) y no se puede permitir que
-- el modelo la parafrasee.
-- ---------------------------------------------------------------------------
create table if not exists public.respuestas_fijas (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  disparadores  text[] not null,
  modo          text not null default 'contiene'
                  check (modo in ('exacto','contiene','regex')),
  respuesta     text not null,
  prioridad     int  not null default 50,
  activa        boolean not null default true,
  veces_usada   int  not null default 0,
  notas         text,
  creada_por    uuid,
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  constraint respuestas_fijas_con_disparadores
    check (array_length(disparadores, 1) >= 1)
);

drop trigger if exists respuestas_fijas_tocar on public.respuestas_fijas;
create trigger respuestas_fijas_tocar before update on public.respuestas_fijas
  for each row execute function public.tocar_actualizado_en();

create index if not exists respuestas_fijas_activas_idx
  on public.respuestas_fijas (activa, prioridad) where activa;

comment on table public.respuestas_fijas is
  'Se envían textuales, sin pasar por el modelo. Para redacción institucional intocable.';
comment on column public.respuestas_fijas.prioridad is
  'Menor gana. Se evalúan antes que FAQs y documentos.';
