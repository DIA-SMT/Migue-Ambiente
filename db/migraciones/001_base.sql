-- ===========================================================================
-- 001 · Extensiones, utilidades y configuración editable
-- ===========================================================================
-- Convención de nombres: identificadores en español, SIN acentos ni ñ.
-- Excepción documentada: las tablas `tickets` y `program_requests` ya existían
-- (bot anterior en ManyChat) y conservan sus nombres y columnas en inglés; las
-- columnas que les agreguemos siguen ESE idioma para que cada tabla sea
-- internamente coherente. Todo lo nuevo va en español.
-- ===========================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;    -- similitud difusa (errores de tipeo)
create extension if not exists unaccent;   -- "poda" == "podá"

-- Búsqueda de texto en español INSENSIBLE A ACENTOS.
-- Sin esto, un vecino que escribe "reciclaje organico" no encuentra
-- "reciclaje orgánico", que es exactamente cómo escribe la gente en el chat.
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'es_sin_acentos') then
    create text search configuration public.es_sin_acentos (copy = spanish);
    alter text search configuration public.es_sin_acentos
      alter mapping for hword, hword_part, word with unaccent, spanish_stem;
  end if;
end $$;

-- to_tsvector(regconfig, text) es IMMUTABLE, así que sirve en columnas
-- generadas. Ojo: hay que pasar la config explícita; la variante de un solo
-- argumento depende de una GUC y no es inmutable.

create or replace function public.tocar_actualizado_en()
returns trigger language plpgsql as $$
begin
  new.actualizado_en = now();
  return new;
end $$;

comment on function public.tocar_actualizado_en is
  'Trigger BEFORE UPDATE: mantiene actualizado_en al día.';

-- ---------------------------------------------------------------------------
-- Configuración del bot editable desde el panel.
-- Todo lo que un operador podría querer cambiar sin un deploy vive acá.
-- ---------------------------------------------------------------------------
create table if not exists public.configuracion (
  clave         text primary key,
  valor         jsonb       not null,
  descripcion   text        not null,
  categoria     text        not null default 'general',
  actualizado_en timestamptz not null default now(),
  actualizado_por uuid
);

drop trigger if exists configuracion_tocar on public.configuracion;
create trigger configuracion_tocar before update on public.configuracion
  for each row execute function public.tocar_actualizado_en();

comment on table public.configuracion is
  'Parámetros operativos (SLA, modelo de IA, umbrales). Editable desde el panel.';

-- ---------------------------------------------------------------------------
-- Textos del bot. NINGÚN mensaje al vecino se escribe en el código: si está
-- acá, Comunicación lo corrige sin tocar un deploy ni esperar a un dev.
-- ---------------------------------------------------------------------------
create table if not exists public.textos_bot (
  clave         text primary key,
  texto         text        not null,
  descripcion   text        not null,
  canal         text,                    -- null = sirve para todos los canales
  actualizado_en timestamptz not null default now(),
  actualizado_por uuid
);

drop trigger if exists textos_bot_tocar on public.textos_bot;
create trigger textos_bot_tocar before update on public.textos_bot
  for each row execute function public.tocar_actualizado_en();

comment on column public.textos_bot.canal is
  'null = vale para todo canal. Permite redactar distinto en Telegram y WhatsApp.';
