-- ===========================================================================
-- 019 · Lo que necesita la sección de Respuestas del panel
-- ===========================================================================
-- Hoy hay CERO FAQs y CERO respuestas fijas cargadas, y es lo de mayor impacto
-- que puede hacer el área: `buscar_conocimiento` le da a una FAQ el doble de
-- peso que a un fragmento de PDF (p_impulso_faq = 2.0), porque una respuesta
-- escrita por una persona del área ya está redactada para un vecino y alguien
-- la revisó.
--
-- Tres cosas:
--
--   1. Que un operador pueda cargar y un supervisor publicar. Hasta ahora
--      `panel_gestiona` daba `for all` a cualquiera del padrón, así que un
--      operador podía publicar sin revisión algo que le llega a un vecino.
--   2. Poder probar una respuesta fija antes de publicarla. Sus disparadores
--      pueden ser `regex`, y una expresión mal escrita atrapa TODO lo que
--      escriba cualquier vecino.
--   3. Saber qué respuesta fija se usó en cada mensaje, que hoy no se registra.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · Publicar es una acción de supervisor
--
-- El modelo: un operador crea y edita en borrador (`activa = false`), y un
-- supervisor o admin es el único que puede poner `activa = true`. Es la
-- diferencia entre «escribí una respuesta» y «esto ya se lo estamos diciendo a
-- los vecinos».
--
-- Se implementa con dos políticas separadas por operación en vez de una `for
-- all`, porque el chequeo de UPDATE necesita mirar la fila nueva (`with check`)
-- y eso no se puede expresar en una política que también cubre el SELECT.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['faqs','respuestas_fijas']
  loop
    -- `create policy` no tiene `if not exists`, así que hay que borrar TODAS
    -- las que este bloque crea, no sólo la que reemplaza. Es una regla del
    -- proyecto desde la 007 y me la volví a olvidar acá: la segunda pasada del
    -- arnés falló con «policy respuestas_lee already exists».
    execute format('drop policy if exists panel_gestiona    on public.%I', t);
    execute format('drop policy if exists respuestas_lee    on public.%I', t);
    execute format('drop policy if exists respuestas_crea   on public.%I', t);
    execute format('drop policy if exists respuestas_edita  on public.%I', t);
    execute format('drop policy if exists respuestas_borra  on public.%I', t);

    -- Leer: cualquiera del padrón, incluidos los borradores. Hace falta para
    -- que un operador vea lo que dejó a medias.
    execute format($p$
      create policy respuestas_lee on public.%I
        for select to authenticated
        using (public.es_personal_panel())$p$, t);

    -- Crear: cualquiera del padrón, pero SIEMPRE como borrador. Un operador no
    -- puede publicar de una.
    execute format($p$
      create policy respuestas_crea on public.%I
        for insert to authenticated
        with check (
          public.es_personal_panel()
          and (activa = false or public.es_admin_panel())
        )$p$, t);

    -- Editar: se puede tocar el texto siempre; poner `activa = true` sólo si es
    -- supervisor o admin. Un operador que intente publicar recibe un error de
    -- política, no un cambio silencioso.
    execute format($p$
      create policy respuestas_edita on public.%I
        for update to authenticated
        using (public.es_personal_panel())
        with check (
          public.es_personal_panel()
          and (activa = false or public.es_admin_panel())
        )$p$, t);

    -- Borrar: sólo supervisor o admin. Una respuesta borrada se pierde con su
    -- contador de uso, que es justamente el dato que dice si servía.
    execute format($p$
      create policy respuestas_borra on public.%I
        for delete to authenticated
        using (public.es_admin_panel())$p$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2 · Probar una respuesta fija antes de publicarla
--
-- Los disparadores admiten modo `regex`, y ahí está el peligro: una expresión
-- como `.*` atrapa absolutamente todo lo que escriba cualquier vecino, y el bot
-- deja de hacer otra cosa que responder eso. Con `contiene` el riesgo es menor
-- pero existe: un disparador como «a» coincide con casi cualquier mensaje.
--
-- Esta función simula la evaluación contra un texto de prueba SIN publicar nada,
-- y devuelve además cuántos de los últimos mensajes reales habría atrapado. Ese
-- segundo número es el que importa: un disparador que coincide con 200 de los
-- últimos 200 mensajes está mal, sin importar lo razonable que parezca.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('probar_disparadores','registrar_uso_respuesta_fija_en_mensaje')
  loop
    execute format('drop function if exists %s cascade', r.firma);
  end loop;
end $$;

-- Se usa `unaccent()`, de la extensión que ya instala la 001 y que usa la
-- configuración de búsqueda `es_sin_acentos`. No hay una función propia de
-- normalización en la base: la del código TypeScript (`normalizar` en
-- src/texto.ts) hace más cosas, pero para comparar disparadores alcanza con
-- bajar a minúsculas y sacar acentos.
create function public.probar_disparadores(
  p_disparadores text[],
  p_modo         text,
  p_texto        text default null
)
returns table (
  coincide_el_texto boolean,
  mensajes_mirados  int,
  mensajes_atrapados int,
  ejemplos          text[]
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_coincide boolean := false;
  v_mirados  int := 0;
  v_atrapados int := 0;
  v_ejemplos text[] := '{}';
  v_d text;
  v_norm text;
begin
  if not public.es_personal_panel() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  if p_modo not in ('exacto','contiene','regex') then
    raise exception 'modo invalido: %', p_modo;
  end if;

  -- ¿Coincide con el texto que escribió quien está probando?
  if p_texto is not null and p_texto <> '' then
    v_norm := lower(unaccent(p_texto));
    foreach v_d in array p_disparadores
    loop
      v_coincide := v_coincide or case p_modo
        when 'exacto'   then v_norm = lower(unaccent(v_d))
        when 'contiene' then position(lower(unaccent(v_d)) in v_norm) > 0
        when 'regex'    then v_norm ~ v_d
      end;
      exit when v_coincide;
    end loop;
  end if;

  -- Y contra los mensajes reales que ya recibió el bot. Es la prueba que
  -- importa: mide el disparador contra lo que la gente escribe de verdad, no
  -- contra lo que uno imagina que va a escribir.
  with ultimos as (
    select texto from public.mensajes
     where direccion = 'entrante' and texto is not null and texto <> ''
     order by creado_en desc
     limit 200
  ), evaluados as (
    select u.texto,
           exists (
             select 1 from unnest(p_disparadores) as d
              where case p_modo
                      when 'exacto'   then lower(unaccent(u.texto)) = lower(unaccent(d))
                      when 'contiene' then position(lower(unaccent(d)) in lower(unaccent(u.texto))) > 0
                      when 'regex'    then lower(unaccent(u.texto)) ~ d
                    end
           ) as atrapado
      from ultimos u
  )
  select count(*)::int,
         count(*) filter (where atrapado)::int,
         coalesce(array_agg(left(texto, 90)) filter (where atrapado), '{}')
    into v_mirados, v_atrapados, v_ejemplos
    from evaluados;

  -- Sólo los primeros cinco ejemplos: la lista es para darse una idea, no para
  -- leerla entera.
  return query select v_coincide, v_mirados, v_atrapados, v_ejemplos[1:5];
end $$;

revoke all on function public.probar_disparadores(text[], text, text) from public, anon;
grant execute on function public.probar_disparadores(text[], text, text) to authenticated, service_role;

comment on function public.probar_disparadores(text[], text, text) is
  'Simula los disparadores de una respuesta fija sin publicarla, y mide cuantos mensajes reales atraparia.';

-- ---------------------------------------------------------------------------
-- 3 · Qué respuesta fija se usó en cada mensaje
--
-- `mensajes.origen_respuesta` ya guarda 'respuesta_fija', pero no CUÁL. Sin eso
-- el único dato de uso es el contador `veces_usada`, que dice cuántas veces se
-- usó pero no en qué conversación ni cuándo — así que no se puede revisar si la
-- respuesta fue apropiada para lo que preguntó el vecino.
--
-- Se agrega la columna con FK y `on delete set null`: si alguien borra la
-- respuesta fija, el mensaje histórico no se pierde ni queda apuntando a nada.
-- ---------------------------------------------------------------------------
alter table public.mensajes
  add column if not exists respuesta_fija_id uuid
    references public.respuestas_fijas(id) on delete set null;

comment on column public.mensajes.respuesta_fija_id is
  'Cual respuesta fija se envio. Null si la respuesta no vino de una.';

create index if not exists mensajes_respuesta_fija_idx
  on public.mensajes (respuesta_fija_id) where respuesta_fija_id is not null;

-- ---------------------------------------------------------------------------
-- 4 · `faqs.prioridad` estaba muerta
--
-- `buscar_conocimiento` ordena por `rank` y no la mira nunca (verificado con
-- grep sobre todo el código). Una columna que el panel muestra como si hiciera
-- algo, y no hace nada, es peor que no tenerla: alguien la va a ajustar
-- esperando un efecto.
--
-- No se borra —hay filas que podrían tenerla cargada en el futuro— pero se
-- documenta con precisión para que el panel no la ofrezca como si sirviera.
-- ---------------------------------------------------------------------------
comment on column public.faqs.prioridad is
  'NO SE USA. buscar_conocimiento ordena por ts_rank y nunca la lee. Se conserva por compatibilidad; el panel no la debe ofrecer como si tuviera efecto.';

comment on column public.faqs.etiquetas is
  'Para filtrar en el panel. NO entra en la busqueda del bot: la columna generada `busqueda` es pregunta + respuesta.';
