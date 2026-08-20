-- ===========================================================================
-- SOLO PARA PRUEBAS LOCALES — no se aplica en Supabase.
--
-- Réplica de las dos tablas que ya existen en Supabase (creadas por el bot
-- anterior en ManyChat), reconstruida a partir de los datos observados vía
-- PostgREST. Permite validar la migración 005 (que las ALTERa) en un Postgres
-- local antes de tocar producción.
-- ===========================================================================

create table if not exists public.tickets (
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  ticket_type            text,
  status                 text,
  address                text,
  waste_type             text,
  quantity               text,
  days_without_service   int,
  photo_url              text,
  chat_id                text,
  user_name              text,
  sla_deadline           timestamptz,
  notes                  text,
  live_chat_url          text
);

create table if not exists public.program_requests (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  program_type        text,
  institution_name    text,
  responsible_person  text,
  student_count       int,
  address             text,
  chat_id             text,
  user_name           text,
  status              text,
  additional_info     text,
  original_timestamp  timestamptz,
  live_chat_url       text
);

-- Un par de filas para que las migraciones que hacen UPDATE tengan qué tocar.
insert into public.tickets (ticket_type, status, address, chat_id, user_name, sla_deadline)
values ('Pedido No Habitual', 'En Proceso', 'Lavalle al 500', '+5493815267804', 'Prueba Uno', now() + interval '3 days')
on conflict do nothing;

insert into public.program_requests (program_type, institution_name, responsible_person, student_count, address, chat_id, user_name, status)
values ('educa', 'Escuela de Prueba', 'Responsable Prueba', 30, 'Muñecas al 200', '+5493815267804', 'Prueba Uno', 'Pendiente')
on conflict do nothing;
