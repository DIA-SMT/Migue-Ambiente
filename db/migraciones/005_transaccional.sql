-- ===========================================================================
-- 005 · Tablas transaccionales existentes: extensión, no reemplazo
-- ===========================================================================
-- `tickets` y `program_requests` vienen del bot anterior (ManyChat) y tienen
-- 22 filas reales. Las conservo y las extiendo en vez de crear tablas nuevas:
-- migrar 22 filas no justifica duplicar el modelo.
--
-- Las columnas nuevas siguen la convención EN INGLÉS de esas tablas, para que
-- cada tabla sea coherente consigo misma. El resto del esquema va en español.
--
-- Hallazgo del relevamiento: `waste_type` y `quantity` están en null en TODAS
-- las filas. La spec exige tipificar y validar volumen, y el bot anterior nunca
-- lo capturaba — por eso aceptó el pedido del árbol caído. El flujo nuevo los
-- hace obligatorios en la aplicación.
-- ===========================================================================

alter table public.tickets
  add column if not exists channel            text,
  add column if not exists conversation_id    uuid references public.conversaciones(id) on delete set null,
  add column if not exists zone               text,
  add column if not exists quantity_value     numeric,
  add column if not exists quantity_unit      text,
  add column if not exists exceeds_limit      boolean not null default false,
  add column if not exists partial_pickup     boolean not null default false,
  add column if not exists derived_to         text,
  add column if not exists resolved_at        timestamptz,
  add column if not exists updated_at         timestamptz not null default now();

-- Las filas heredadas de ManyChat quedan marcadas como tal, para que las
-- métricas del panel puedan separar "antes" de "después" sin ambigüedad.
update public.tickets set channel = 'manychat' where channel is null;

-- `not valid` = no revalida las 22 filas heredadas, sólo exige la regla de acá
-- en adelante. El drop previo hace la migración re-ejecutable.
alter table public.tickets drop constraint if exists tickets_channel_valido;
alter table public.tickets
  add constraint tickets_channel_valido
    check (channel in ('telegram','whatsapp','web','manychat')) not valid;

create index if not exists tickets_estado_idx on public.tickets (status, created_at desc);
create index if not exists tickets_tipo_idx   on public.tickets (ticket_type);
create index if not exists tickets_conversacion_idx on public.tickets (conversation_id);
create index if not exists tickets_sla_idx on public.tickets (sla_deadline)
  where status <> 'Resuelto';

comment on column public.tickets.exceeds_limit is
  'El pedido superaba el límite gratuito. Con accion_al_exceder=parcial_con_ticket se registra igual.';
comment on column public.tickets.partial_pickup is
  'Se retira sólo hasta el máximo permitido; el excedente se derivó a Puntos Verdes.';

-- ---------------------------------------------------------------------------
alter table public.program_requests
  add column if not exists channel         text,
  add column if not exists conversation_id uuid references public.conversaciones(id) on delete set null,
  add column if not exists contact_phone   text,
  add column if not exists preferred_time  text,
  add column if not exists resolved_at     timestamptz,
  add column if not exists updated_at       timestamptz not null default now();

update public.program_requests set channel = 'manychat' where channel is null;

alter table public.program_requests drop constraint if exists program_requests_channel_valido;
alter table public.program_requests
  add constraint program_requests_channel_valido
    check (channel in ('telegram','whatsapp','web','manychat')) not valid;

create index if not exists program_requests_estado_idx
  on public.program_requests (status, created_at desc);
create index if not exists program_requests_tipo_idx
  on public.program_requests (program_type);
-- ---------------------------------------------------------------------------
-- Estas dos tablas usan `updated_at` (inglés), no `actualizado_en`, así que
-- necesitan su propia función de trigger. Duplicar cuatro líneas es preferible
-- a renombrar columnas de tablas que ya tienen datos productivos.
-- ---------------------------------------------------------------------------
create or replace function public.tocar_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists tickets_tocar on public.tickets;
create trigger tickets_tocar before update on public.tickets
  for each row execute function public.tocar_updated_at();

drop trigger if exists program_requests_tocar on public.program_requests;
create trigger program_requests_tocar before update on public.program_requests
  for each row execute function public.tocar_updated_at();
