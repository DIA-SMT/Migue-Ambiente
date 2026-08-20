-- SOLO PARA PRUEBAS LOCALES.
-- Supabase provee estos roles; un Postgres común no los tiene, así que las
-- políticas de RLS de la migración 007 fallarían al referenciarlos.
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
