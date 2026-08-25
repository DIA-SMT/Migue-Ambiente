-- ===========================================================================
-- 021 · Cerrar el circuito: de una pregunta sin responder a una respuesta
-- ===========================================================================
-- La tabla `sin_respuesta` ya tenía el diseño completo desde la 004:
-- `resuelta_con_faq_id` y `resuelta_con_fija_id` apuntan a la respuesta que
-- resolvió la pregunta. Lo que faltaba era hacerlo en UNA transacción.
--
-- Son dos escrituras —crear la respuesta y marcar la pregunta— y PostgREST hace
-- cada llamada HTTP en su propia transacción. Si la segunda falla, queda una
-- respuesta escrita y la pregunta todavía en la lista de pendientes: alguien la
-- va a volver a resolver y van a quedar dos respuestas para lo mismo, compitiendo
-- entre ellas en el ranking del buscador.
--
-- Y hay una decisión de fondo acá: una pregunta se marca resuelta al VINCULARLA,
-- no al publicar la respuesta. Un operador puede escribir el borrador y dejarlo
-- para que un supervisor lo publique, y en el medio la pregunta no tiene que
-- seguir apareciendo como pendiente —ya alguien se hizo cargo—. El panel muestra
-- si la respuesta vinculada está publicada o sigue en borrador, que es la
-- información que hace falta para no dar por cerrado algo que el vecino todavía
-- no puede recibir.
-- ===========================================================================

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('resolver_con_faq','resolver_con_fija','descartar_sin_respuesta')
  loop
    execute format('drop function if exists %s cascade', r.firma);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Resolver escribiendo una pregunta frecuente
--
-- `p_publicar` respeta la misma regla que las políticas de la 019: sólo un
-- supervisor o un admin puede dejar algo publicado. Acá se verifica adentro
-- porque la función es SECURITY DEFINER y las políticas no se aplican.
-- ---------------------------------------------------------------------------
create function public.resolver_con_faq(
  p_sin_respuesta_id uuid,
  p_pregunta         text,
  p_respuesta        text,
  p_etiquetas        text[] default '{}',
  p_publicar         boolean default false
)
returns table (faq_id uuid, publicada boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_faq_id uuid;
  v_publicar boolean;
  v_usuario uuid := auth.uid();
begin
  if not public.es_personal_panel() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  if coalesce(trim(p_pregunta), '') = '' or coalesce(trim(p_respuesta), '') = '' then
    raise exception 'la pregunta y la respuesta no pueden estar vacias';
  end if;

  if not exists (select 1 from public.sin_respuesta where id = p_sin_respuesta_id) then
    raise exception 'no existe esa pregunta sin responder';
  end if;

  -- Publicar es de supervisor. En vez de fallar, se guarda como borrador: quien
  -- escribió no pierde el trabajo por no tener el permiso.
  v_publicar := p_publicar and public.es_admin_panel();

  insert into public.faqs (pregunta, respuesta, etiquetas, activa, creada_por)
  values (trim(p_pregunta), trim(p_respuesta), coalesce(p_etiquetas, '{}'), v_publicar, v_usuario)
  returning id into v_faq_id;

  update public.sin_respuesta
     set estado = 'resuelta',
         resuelta_con_faq_id = v_faq_id,
         resuelta_con_fija_id = null,
         revisada_por = v_usuario
   where id = p_sin_respuesta_id;

  return query select v_faq_id, v_publicar;
end $$;

-- ---------------------------------------------------------------------------
-- Resolver con una respuesta textual
--
-- Sin prueba de disparadores acá: esta función se usa desde el panel, que ya
-- obliga a probarlos antes de dejar publicar. Y si se guarda como borrador, el
-- disparador todavía no afecta a nadie.
-- ---------------------------------------------------------------------------
create function public.resolver_con_fija(
  p_sin_respuesta_id uuid,
  p_nombre           text,
  p_disparadores     text[],
  p_modo             text,
  p_respuesta        text,
  p_publicar         boolean default false,
  p_notas            text default null
)
returns table (fija_id uuid, publicada boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_fija_id uuid;
  v_publicar boolean;
  v_usuario uuid := auth.uid();
begin
  if not public.es_personal_panel() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  if coalesce(trim(p_nombre), '') = '' or coalesce(trim(p_respuesta), '') = '' then
    raise exception 'el nombre y la respuesta no pueden estar vacios';
  end if;
  if p_disparadores is null or array_length(p_disparadores, 1) is null then
    raise exception 'hace falta al menos un disparador';
  end if;
  if p_modo not in ('exacto','contiene','regex') then
    raise exception 'modo invalido: %', p_modo;
  end if;

  if not exists (select 1 from public.sin_respuesta where id = p_sin_respuesta_id) then
    raise exception 'no existe esa pregunta sin responder';
  end if;

  v_publicar := p_publicar and public.es_admin_panel();

  insert into public.respuestas_fijas (nombre, disparadores, modo, respuesta, activa, notas, creada_por)
  values (trim(p_nombre), p_disparadores, p_modo, trim(p_respuesta), v_publicar,
          nullif(trim(coalesce(p_notas, '')), ''), v_usuario)
  returning id into v_fija_id;

  update public.sin_respuesta
     set estado = 'resuelta',
         resuelta_con_fija_id = v_fija_id,
         resuelta_con_faq_id = null,
         revisada_por = v_usuario
   where id = p_sin_respuesta_id;

  return query select v_fija_id, v_publicar;
end $$;

-- ---------------------------------------------------------------------------
-- Descartar una pregunta
--
-- No todo lo que el bot no supo responder merece una respuesta: hay pruebas,
-- mensajes sin sentido y cosas que no son del área. Descartar es una acción de
-- primera clase y no un borrado: la fila queda, con el motivo, así que se puede
-- revisar si se descartó de más.
-- ---------------------------------------------------------------------------
create function public.descartar_sin_respuesta(
  p_sin_respuesta_id uuid,
  p_motivo           text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.es_personal_panel() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  update public.sin_respuesta
     set estado = 'descartada',
         notas = coalesce(nullif(trim(coalesce(p_motivo, '')), ''), notas),
         revisada_por = auth.uid()
   where id = p_sin_respuesta_id;

  if not found then raise exception 'no existe esa pregunta sin responder'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Permisos: los tres los usa el panel, y los tres verifican el padrón adentro
-- ---------------------------------------------------------------------------
revoke all on function public.resolver_con_faq(uuid, text, text, text[], boolean) from public, anon;
revoke all on function public.resolver_con_fija(uuid, text, text[], text, text, boolean, text) from public, anon;
revoke all on function public.descartar_sin_respuesta(uuid, text) from public, anon;

grant execute on function public.resolver_con_faq(uuid, text, text, text[], boolean) to authenticated;
grant execute on function public.resolver_con_fija(uuid, text, text[], text, text, boolean, text) to authenticated;
grant execute on function public.descartar_sin_respuesta(uuid, text) to authenticated;

comment on function public.resolver_con_faq(uuid, text, text, text[], boolean) is
  'Crea una FAQ y marca la pregunta como resuelta, en una sola transaccion.';
comment on function public.resolver_con_fija(uuid, text, text[], text, text, boolean, text) is
  'Crea una respuesta textual y marca la pregunta como resuelta, en una sola transaccion.';
comment on function public.descartar_sin_respuesta(uuid, text) is
  'Marca una pregunta como descartada. No borra la fila: queda el motivo.';

-- ---------------------------------------------------------------------------
-- Vista de trabajo
--
-- Junta la pregunta con el estado de la respuesta que la resolvió. Sin esto el
-- panel tendría que hacer tres consultas y unirlas en el cliente, y no podría
-- ordenar por «lo más repetido primero» sin traerse todo.
-- ---------------------------------------------------------------------------
drop view if exists public.v_sin_respuesta;
create view public.v_sin_respuesta
with (security_invoker = true) as
  select s.id,
         s.pregunta,
         s.motivo,
         s.confianza,
         s.veces_repetida,
         s.estado,
         s.notas,
         s.creado_en,
         s.actualizado_en,
         s.resuelta_con_faq_id,
         s.resuelta_con_fija_id,
         -- Qué se escribió para resolverla, y si ya está en circulación. Una
         -- pregunta «resuelta» con un borrador sin publicar NO está contestada
         -- todavía, y el panel tiene que poder decirlo.
         coalesce(f.pregunta, rf.nombre)                as respuesta_titulo,
         coalesce(f.activa, rf.activa)                  as respuesta_publicada,
         case
           when s.resuelta_con_faq_id  is not null then 'faq'
           when s.resuelta_con_fija_id is not null then 'fija'
           else null
         end                                            as respuesta_tipo
    from public.sin_respuesta s
    left join public.faqs f              on f.id  = s.resuelta_con_faq_id
    left join public.respuestas_fijas rf on rf.id = s.resuelta_con_fija_id;

comment on view public.v_sin_respuesta is
  'Preguntas sin responder con el estado de la respuesta que las resolvio. security_invoker: hereda el RLS de las tablas.';
