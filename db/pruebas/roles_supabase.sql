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

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  email_confirmed_at timestamptz,
  created_at         timestamptz not null default now()
);

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
