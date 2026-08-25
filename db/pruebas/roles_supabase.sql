-- SOLO PARA PRUEBAS LOCALES.
--
-- Simula lo que Supabase da por hecho y un Postgres común no tiene: los tres
-- roles (anon, authenticated, service_role) y el esquema `auth` con `users` y
-- `uid()`.
--
-- Ojo con la diferencia, que ya causó un fallo: los ROLES son de cluster, así
-- que alcanzaba con crearlos una vez en cualquier base. El ESQUEMA es de base,
-- así que este archivo hay que aplicarlo con `-d` sobre CADA base de prueba.
-- Sin eso, las migraciones que referencian `auth.users` fallan con
-- «schema "auth" does not exist» mientras los roles funcionan igual.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Esquema `auth`, que en Supabase viene dado y en un Postgres común no existe.
--
-- Hace falta desde la migración 017: `personal_panel` referencia
-- `auth.users(id)` y los predicados de las políticas llaman a `auth.uid()`.
--
-- `auth.uid()` replica la implementación real de Supabase: lee el `sub` del JWT
-- desde un ajuste de la sesión. Eso es lo que permite probar las políticas con
-- `set_config('request.jwt.claim.sub', ...)` sin levantar Supabase Auth.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

-- Las columnas de `auth.users` que el proyecto LEE. No es el esquema completo de
-- Supabase —tiene decenas— sino las que aparecen en alguna consulta nuestra, y
-- por eso hay que agregar acá cualquiera nueva que se use: `cuentas_sin_padron`
-- falló contra esta base por pedir `last_sign_in_at`, que en Supabase existe y
-- acá no estaba.
--
-- Y las que NO están son deliberadas: `encrypted_password`,
-- `confirmation_token`, `recovery_token` y `raw_app_meta_data` no se agregan. Si
-- una función nuestra alguna vez las pidiera, tiene que fallar acá y no pasar
-- desapercibida hasta producción.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  deleted_at         timestamptz,
  created_at         timestamptz not null default now()
);

-- Idempotente: si la tabla ya existía de una corrida anterior, se le suman las
-- columnas que falten en vez de fallar.
alter table auth.users add column if not exists last_sign_in_at timestamptz;
alter table auth.users add column if not exists deleted_at      timestamptz;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    'anon'
  );
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Esquema `storage`, que en Supabase viene dado.
--
-- Hace falta desde la 018: el panel sube documentos al bucket y sus políticas
-- viven en storage.objects. Sin el stub, la 018 saltea ese bloque y las
-- políticas nunca se validan — o sea, el arnés diría OK sobre algo que no
-- probó.
--
-- Sólo las columnas que las políticas realmente usan.
-- ---------------------------------------------------------------------------
create schema if not exists storage;

create table if not exists storage.buckets (
  id     text primary key,
  name   text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text,
  owner      uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

insert into storage.buckets (id, name, public) values
  ('documentos', 'documentos', false),
  ('media',      'media',      false)
on conflict (id) do nothing;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Privilegios de tabla, como los da Supabase.
--
-- En Supabase los roles `anon` y `authenticated` TIENEN privilegios de tabla
-- sobre todo el esquema public. Lo único que los limita es Row Level Security.
-- Es un detalle central del modelo y el arnés tiene que reproducirlo: si acá
-- `anon` no tuviera GRANT, un test podría «pasar» por falta de privilegio y no
-- porque la política funcione, y en producción la política es lo único que hay.
--
-- Se usan default privileges porque las tablas todavía no existen: las crean
-- las migraciones después de este archivo.
-- ---------------------------------------------------------------------------
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

-- Y las FUNCIONES a los tres roles, que es lo que hace Supabase de verdad.
--
-- Acá decía sólo `service_role`, y esa diferencia con producción hizo que el
-- arnés no pudiera ver un hallazgo real: once funciones de `public` quedaron
-- ejecutables por la clave pública, y la vista de auditoría que se escribió para
-- detectarlo daba cero alertas contra esta base — no porque la regla estuviera
-- bien, sino porque acá la condición nunca se daba.
--
-- Es el mismo argumento que el comentario de arriba hace para las tablas: si el
-- arnés no reproduce los permisos amplios de Supabase, un test puede pasar por
-- falta de privilegio en vez de porque la protección funcione.
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
