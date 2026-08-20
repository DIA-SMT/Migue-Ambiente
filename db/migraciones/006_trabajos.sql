-- ===========================================================================
-- 006 · Cola de trabajos (panel -> worker en la VPS)
-- ===========================================================================
-- Este mecanismo es lo que evita exponer un puerto en la VPS. El panel no
-- llama a la VPS: escribe una fila acá. El worker la consume.
--
-- Beneficio lateral importante: si el worker está caído, el trabajo queda
-- encolado en vez de fallar. Con una API HTTP, la subida del documento
-- fracasaba y el operador tenía que reintentar.
-- ===========================================================================

create table if not exists public.trabajos (
  id            uuid primary key default gen_random_uuid(),
  tipo          text not null check (tipo in
                  ('ingestar_documento','reindexar_documento','borrar_documento','reindexar_todo')),
  payload       jsonb not null default '{}',
  estado        text not null default 'pendiente'
                  check (estado in ('pendiente','tomado','listo','error')),
  intentos      int  not null default 0,
  max_intentos  int  not null default 3,
  error_detalle text,
  prioridad     int  not null default 100,
  -- `tomado_por` + `tomado_en` permiten detectar un worker que murió a mitad
  -- de un trabajo y devolver la fila a la cola.
  tomado_por    text,
  tomado_en     timestamptz,
  creado_en     timestamptz not null default now(),
  finalizado_en timestamptz,
  creado_por    uuid
);

create index if not exists trabajos_pendientes_idx
  on public.trabajos (prioridad, creado_en) where estado = 'pendiente';
create index if not exists trabajos_tomados_idx
  on public.trabajos (tomado_en) where estado = 'tomado';

-- ---------------------------------------------------------------------------
-- Toma atómica de trabajo.
--
-- FOR UPDATE SKIP LOCKED es lo que hace que esto sea seguro con varios workers:
-- cada uno se lleva una fila distinta sin bloquearse entre ellos. Sin SKIP
-- LOCKED, dos workers se pelean por la misma fila y uno queda esperando.
-- ---------------------------------------------------------------------------
create or replace function public.tomar_trabajo(p_worker text)
returns setof public.trabajos
language plpgsql as $$
begin
  return query
  update public.trabajos t
     set estado     = 'tomado',
         tomado_por = p_worker,
         tomado_en  = now(),
         intentos   = t.intentos + 1
   where t.id = (
     select id from public.trabajos
      where estado = 'pendiente'
      order by prioridad, creado_en
      for update skip locked
      limit 1
   )
  returning t.*;
end $$;

-- Un worker que muere deja su trabajo en 'tomado' para siempre. Esto lo
-- devuelve a la cola si pasó demasiado tiempo, o lo marca en error si ya
-- agotó los intentos.
create or replace function public.recuperar_trabajos_colgados(p_minutos int default 15)
returns int language plpgsql as $$
declare v_recuperados int;
begin
  with recuperados as (
    update public.trabajos
       set estado = case when intentos >= max_intentos then 'error' else 'pendiente' end,
           error_detalle = case when intentos >= max_intentos
                                then 'El worker no respondió tras ' || intentos || ' intentos'
                                else error_detalle end,
           tomado_por = null,
           tomado_en  = null
     where estado = 'tomado'
       and tomado_en < now() - make_interval(mins => p_minutos)
    returning 1
  )
  select count(*) into v_recuperados from recuperados;
  return v_recuperados;
end $$;

comment on function public.tomar_trabajo is
  'Toma un trabajo de forma atómica. Seguro con múltiples workers (SKIP LOCKED).';
