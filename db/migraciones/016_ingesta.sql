-- ===========================================================================
-- 016 · Soporte de ingesta para el worker
-- ===========================================================================
-- Dos operaciones que TIENEN que ser atómicas y que PostgREST no puede hacer
-- atómicas desde el cliente, porque cada llamada HTTP es su propia
-- transacción:
--
--   1. Reemplazar los fragmentos de un documento. Son un DELETE y un INSERT.
--      Si se hacen en dos llamadas y la segunda falla, el documento queda con
--      cero fragmentos pero marcado como listo: el buscador deja de encontrarlo
--      y nadie se entera hasta que un vecino pregunta algo que estaba ahí.
--
--   2. Cerrar un trabajo. Decidir entre 'listo', 'error' y volver a 'pendiente'
--      depende de `intentos` contra `max_intentos`, y esa lectura y su escritura
--      tienen que ser la misma transacción para que dos workers no lleguen a
--      conclusiones distintas sobre la misma fila.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Reemplazo atómico de los fragmentos de un documento.
--
-- Recibe los fragmentos como jsonb en vez de como filas porque así entra todo
-- en una sola llamada: 34 fragmentos son 34 inserts por HTTP, y en la primera
-- medición contra Supabase cada ida y vuelta costaba entre 40 y 60 ms.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  -- `create or replace` con la firma cambiada no reemplaza: crea una sobrecarga,
  -- y después `comment on function` falla con «is not unique». Regla del
  -- proyecto: borrar todas las sobrecargas propias antes de crear.
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('reemplazar_fragmentos','terminar_trabajo','encolar_reindexado')
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid and d.deptype = 'e'
       )
  loop
    execute format('drop function if exists %s cascade', r.firma);
  end loop;
end $$;

create function public.reemplazar_fragmentos(
  p_documento_id uuid,
  p_fragmentos   jsonb,
  p_paginas      int  default null,
  p_hash         text default null
) returns int
language plpgsql as $$
declare v_cantidad int;
begin
  if not exists (select 1 from public.documentos where id = p_documento_id) then
    raise exception 'no existe el documento %', p_documento_id;
  end if;

  delete from public.fragmentos where documento_id = p_documento_id;

  insert into public.fragmentos (documento_id, orden, texto, pagina, titulo_seccion, tokens_aprox)
  select p_documento_id,
         (f->>'orden')::int,
         f->>'texto',
         nullif(f->>'pagina','')::int,
         nullif(f->>'titulo_seccion',''),
         nullif(f->>'tokens_aprox','')::int
    from jsonb_array_elements(coalesce(p_fragmentos, '[]'::jsonb)) as f;

  select count(*) into v_cantidad
    from public.fragmentos where documento_id = p_documento_id;

  update public.documentos
     set estado              = case when v_cantidad > 0 then 'listo' else 'error' end,
         error_detalle       = case when v_cantidad > 0 then null
                                    else 'La extracción no produjo ningún fragmento indexable' end,
         cantidad_fragmentos = v_cantidad,
         paginas             = coalesce(p_paginas, paginas),
         hash_sha256         = coalesce(p_hash, hash_sha256)
   where id = p_documento_id;

  return v_cantidad;
end $$;

comment on function public.reemplazar_fragmentos(uuid, jsonb, int, text) is
  'Borra e inserta los fragmentos de un documento en una sola transacción, y actualiza su estado.';

-- ---------------------------------------------------------------------------
-- Cierre de un trabajo, con la política de reintentos en un solo lugar.
--
-- Sin error: queda 'listo'.
-- Con error y con intentos disponibles: vuelve a 'pendiente' para que otro
-- worker lo tome. `tomar_trabajo` ya incrementó `intentos`, así que la cuenta
-- avanza sola y no hay forma de reintentar para siempre.
-- Con error y sin intentos: queda 'error' y lo ve el panel.
--
-- `p_definitivo` corta los reintentos de una vez. Hay errores que no cambian
-- por insistir: un PDF escaneado sin capa de texto, un formato que no se puede
-- leer, un payload mal armado. Reintentarlos tres veces es bajar y procesar el
-- mismo archivo tres veces para llegar al mismo lugar, y mientras tanto el
-- trabajo vuelve a la cola y tapa a los que sí pueden avanzar.
-- ---------------------------------------------------------------------------
create function public.terminar_trabajo(
  p_id         uuid,
  p_error      text    default null,
  p_definitivo boolean default false
) returns public.trabajos
language plpgsql as $$
declare v_fila public.trabajos;
begin
  -- La condición se calcula UNA vez y se usa en las tres columnas. Repetirla
  -- tres veces es como estaba antes, y era una invitación a que una quedara
  -- desincronizada de las otras en el próximo cambio.
  update public.trabajos t
     set estado = case
                    when p_error is null          then 'listo'
                    when p_definitivo             then 'error'
                    when intentos >= max_intentos then 'error'
                    else                               'pendiente'
                  end,
         error_detalle = p_error,
         -- Se libera el dueño sólo si vuelve a la cola. En 'listo' y 'error'
         -- se conserva para poder auditar qué worker lo procesó.
         tomado_por = case when vuelve_a_la_cola then null else tomado_por end,
         tomado_en  = case when vuelve_a_la_cola then null else tomado_en  end,
         finalizado_en = case when vuelve_a_la_cola then null else now() end
    from (select p_error is not null
                 and not p_definitivo
                 and t0.intentos < t0.max_intentos as vuelve_a_la_cola
            from public.trabajos t0 where t0.id = p_id) calculado
   where t.id = p_id
  returning t.* into v_fila;

  if v_fila.id is null then
    raise exception 'no existe el trabajo %', p_id;
  end if;

  return v_fila;
end $$;

comment on function public.terminar_trabajo(uuid, text, boolean) is
  'Cierra un trabajo: listo, error, o de vuelta a pendiente si quedan intentos. p_definitivo corta los reintentos.';

-- ---------------------------------------------------------------------------
-- Encola un reindexado por cada documento activo.
--
-- Un solo trabajo que reindexe los ocho documentos sería un error: si falla el
-- quinto, el reintento vuelve a procesar los cuatro que ya estaban bien, y si
-- agota los intentos se marca en error todo el lote sin distinguir qué falló.
-- ---------------------------------------------------------------------------
create function public.encolar_reindexado(p_creado_por uuid default null)
returns int
language plpgsql as $$
declare v_encolados int;
begin
  with nuevos as (
    insert into public.trabajos (tipo, payload, creado_por, prioridad)
    select 'reindexar_documento',
           jsonb_build_object('documento_id', d.id),
           p_creado_por,
           -- Más abajo en la cola que una subida nueva: el panel espera por la
           -- subida, nadie espera por un reindexado masivo.
           200
      from public.documentos d
     where d.activo
       -- No se duplica un reindexado que ya está esperando para ese documento.
       and not exists (
         select 1 from public.trabajos t
          where t.tipo = 'reindexar_documento'
            and t.estado in ('pendiente','tomado')
            and t.payload->>'documento_id' = d.id::text
       )
    returning 1
  )
  select count(*) into v_encolados from nuevos;

  return v_encolados;
end $$;

comment on function public.encolar_reindexado(uuid) is
  'Encola un reindexado por documento activo, sin duplicar los que ya esperan.';
