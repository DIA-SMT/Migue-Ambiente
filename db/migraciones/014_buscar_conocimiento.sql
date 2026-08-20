-- ===========================================================================
-- 014 · Búsqueda de conocimiento
-- ===========================================================================
-- Busca en FAQs y en fragmentos de documentos a la vez, con ranking unificado.
--
-- Va como función en la base y no como consultas desde la aplicación por tres
-- razones concretas:
--
--   1. `ts_rank` no se puede usar para ordenar desde PostgREST.
--   2. Unir dos tablas con rankings comparables requiere un UNION con la
--      misma expresión de ranking en las dos ramas.
--   3. El respaldo por similitud trigram —para cuando el vecino escribe con
--      errores y el FTS no encuentra nada— necesita ejecutarse condicionalmente
--      según el resultado de la primera búsqueda. Dos viajes de red para eso
--      serían dos veces la latencia mientras alguien espera respuesta.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Se borran TODAS las sobrecargas antes de crear.
--
-- `create or replace function` con una firma distinta no reemplaza: crea una
-- sobrecarga nueva y deja la vieja viva. Esta migración cambió de firma al
-- agregar `p_terminos`, y el resultado fue dos funciones con el mismo nombre —
-- que además hace fallar cualquier `comment on function` sin lista de
-- argumentos, con «function name is not unique».
--
-- El arnés de validación local no puede detectar esto: crea una base nueva en
-- cada corrida, así que nunca hay una versión anterior con la que chocar. Por
-- eso conviene que TODA función de este esquema se borre antes de crearse.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select oid::regprocedure as firma
      from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'buscar_conocimiento'
  loop
    execute format('drop function %s', f.firma);
  end loop;
end $$;

create function public.buscar_conocimiento(
  p_consulta   text,
  -- Términos de la expansión, separados por espacios. Opcional.
  --
  -- Van aparte de la consulta y NO concatenados, por una razón que costó un
  -- bug: `websearch_to_tsquery` une los términos con AND. Pegar los términos
  -- expandidos a la consulta hacía la búsqueda MÁS restrictiva —exigía que
  -- aparecieran todos— cuando el objetivo de expandir es exactamente el
  -- contrario. Acá se usan para armar una consulta OR aparte.
  p_terminos   text default null,
  p_limite     int  default 8,
  -- Cuánto pesa más una FAQ que un fragmento de PDF. Una respuesta escrita por
  -- un humano del área le gana a un pedazo de documento institucional: ya está
  -- redactada para un vecino y alguien la revisó.
  p_impulso_faq real default 2.0,
  -- Umbral del respaldo difuso, sobre `word_similarity`.
  --
  -- 0.35 sale de medir, no de estimar. Con la consulta «recoridro del camoin»
  -- contra «¿Cómo verifico el recorrido del camión?»:
  --   similarity      0.295  — y las FAQs de ruido daban hasta 0.100
  --   word_similarity 0.520  — y el ruido no pasaba de 0.143
  -- `similarity` penaliza que la pregunta sea más larga que la consulta, así
  -- que la coincidencia correcta quedaba a 0.005 de perderse. `word_similarity`
  -- compara contra la mejor porción de la pregunta y deja el margen holgado.
  p_umbral_difuso real default 0.35
)
returns table (
  origen           text,
  id               uuid,
  titulo           text,
  texto            text,
  documento_titulo text,
  pagina           int,
  rank             real,
  difuso           boolean
)
language plpgsql
-- volatile (el default) y no stable: la función llama a set_limit(), que
-- modifica estado de sesión. Declararla stable sería mentir sobre eso.
security definer
set search_path = public
as $$
declare
  v_consulta tsquery;
  v_amplia   tsquery;
  v_palabras text;
  -- Se pregunta explícitamente si hay resultados en vez de leer ROW_COUNT
  -- después de un RETURN QUERY. plpgsql no documenta claramente esa
  -- combinación, y una suposición sobre este lenguaje ya costó dos errores en
  -- producción. Un EXISTS cuesta poco y no deja lugar a dudas.
  v_hay_resultados boolean;
begin
  -- Nivel 1 · PRECISIÓN. websearch_to_tsquery une con AND: exige que
  -- aparezcan todos los términos. Cuando encuentra algo, es lo más relevante.
  v_consulta := websearch_to_tsquery('public.es_sin_acentos', coalesce(p_consulta, ''));

  if v_consulta is null or numnode(v_consulta) = 0 then
    return;
  end if;

  select exists (
    select 1 from public.faqs f where f.activa and f.busqueda @@ v_consulta
    union all
    select 1
      from public.fragmentos fr
      join public.documentos d on d.id = fr.documento_id
     where d.activo and d.estado = 'listo' and fr.busqueda @@ v_consulta
  ) into v_hay_resultados;

  -- Nivel 2 · RECALL. Si el AND no encontró nada, se prueba con OR sobre la
  -- consulta más los términos expandidos. `ts_rank` se encarga de ordenar: un
  -- documento que coincide en más términos rankea más alto, así que abrir a OR
  -- no arruina la relevancia, sólo amplía el conjunto candidato.
  if not v_hay_resultados then
    -- Se sanea antes de armar la consulta: to_tsquery se rompe con paréntesis
    -- o signos, y estos términos los escribió un modelo de lenguaje.
    v_palabras := regexp_replace(
      lower(coalesce(p_consulta, '') || ' ' || coalesce(p_terminos, '')),
      '[^a-záéíóúüñ0-9 ]', ' ', 'g'
    );
    v_palabras := array_to_string(
      array(select distinct w from unnest(string_to_array(v_palabras, ' ')) w where length(w) >= 3),
      ' | '
    );

    if v_palabras <> '' then
      begin
        v_amplia := to_tsquery('public.es_sin_acentos', v_palabras);
      exception when others then
        -- Un término raro que igual rompió to_tsquery no puede dejar al bot
        -- sin responder: se sigue al respaldo difuso.
        v_amplia := null;
      end;
    end if;

    if v_amplia is not null and numnode(v_amplia) > 0 then
      select exists (
        select 1 from public.faqs f where f.activa and f.busqueda @@ v_amplia
        union all
        select 1
          from public.fragmentos fr
          join public.documentos d on d.id = fr.documento_id
         where d.activo and d.estado = 'listo' and fr.busqueda @@ v_amplia
      ) into v_hay_resultados;

      if v_hay_resultados then
        v_consulta := v_amplia;
      end if;
    end if;
  end if;

  if not v_hay_resultados then
    -- Respaldo difuso: probablemente el vecino escribió con errores de tipeo o
    -- usó una palabra que no aparece en ningún documento. La similitud trigram
    -- no depende del diccionario del idioma.
    --
    -- Sólo busca en FAQs, a propósito. Un fragmento de PDF son cientos de
    -- palabras: comparar una consulta corta contra eso da ruido. Y una consulta
    -- mal escrita es casi siempre una pregunta frecuente, que es justo lo que
    -- las FAQs cubren.
    perform set_config('pg_trgm.word_similarity_threshold', p_umbral_difuso::text, true);

    return query
      select 'faq'::text,
             f.id,
             f.pregunta,
             f.respuesta,
             null::text,
             null::int,
             (word_similarity(p_consulta, f.pregunta) * p_impulso_faq)::real,
             true
        from public.faqs f
       where f.activa
         and p_consulta <% f.pregunta
       order by word_similarity(p_consulta, f.pregunta) desc
       limit p_limite;
    return;
  end if;

  return query
    with de_faqs as (
      select 'faq'::text                                    as origen,
             f.id,
             f.pregunta                                     as titulo,
             f.respuesta                                    as texto,
             null::text                                     as documento_titulo,
             null::int                                      as pagina,
             (ts_rank(f.busqueda, v_consulta) * p_impulso_faq)::real as rank,
             false                                          as difuso
        from public.faqs f
       where f.activa
         and f.busqueda @@ v_consulta
    ),
    de_fragmentos as (
      select 'fragmento'::text                as origen,
             fr.id,
             fr.titulo_seccion                as titulo,
             fr.texto,
             d.titulo                         as documento_titulo,
             fr.pagina,
             ts_rank(fr.busqueda, v_consulta)::real as rank,
             false                            as difuso
        from public.fragmentos fr
        join public.documentos d on d.id = fr.documento_id
       where d.activo
         and d.estado = 'listo'
         and fr.busqueda @@ v_consulta
    )
    select * from (
      select * from de_faqs
      union all
      select * from de_fragmentos
    ) todo
    order by todo.rank desc
    limit p_limite;
end $$;

comment on function public.buscar_conocimiento(text, text, int, real, real) is
  'Busca en FAQs y fragmentos con ranking unificado, en tres niveles: AND (precisión), OR con términos expandidos (recall) y similitud trigram (tolerancia a errores de tipeo). Las FAQs pesan más porque las escribió un humano del área.';

-- ---------------------------------------------------------------------------
-- Contadores de uso
-- ---------------------------------------------------------------------------
-- El panel necesita saber qué FAQ se usa y cuál no: una FAQ que nunca se usa
-- puede estar mal redactada, o puede ser que nadie pregunte eso.
drop function if exists public.registrar_uso_faq(uuid[]);
create function public.registrar_uso_faq(p_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.faqs
     set veces_usada = veces_usada + 1
   where id = any(p_ids);
$$;

drop function if exists public.registrar_uso_respuesta_fija(uuid);
create function public.registrar_uso_respuesta_fija(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.respuestas_fijas
     set veces_usada = veces_usada + 1
   where id = p_id;
$$;
