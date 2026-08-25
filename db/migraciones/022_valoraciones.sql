-- ===========================================================================
-- 022 · El vecino vota si la respuesta le sirvió
-- ===========================================================================
-- Hasta acá el bot preguntaba «¿te sirvió?» y la respuesta se perdía en el
-- texto de la conversación. Nadie la contaba, así que no había forma de saber
-- si Migue sirve — sólo de saber cuántas veces habló.
--
-- El voto se cuelga del MENSAJE valorado, no de la conversación. Una charla
-- puede tener cuatro preguntas: tres bien contestadas y una mal. Colgarlo de la
-- conversación promediaría eso hasta volverlo inútil, y lo que hace falta saber
-- es cuál de las cuatro falló para poder escribir esa respuesta.
--
-- Y el comentario va JUNTO al voto y no como un mensaje más de la charla. El
-- pulgar dice cuántas veces falló; el comentario dice qué escribir para
-- arreglarlo. Separados, hay que leer la conversación entera para recuperar el
-- segundo, que es justo el trabajo que esta tabla viene a evitar.
-- ===========================================================================

create table if not exists public.valoraciones (
  id              uuid primary key default gen_random_uuid(),

  conversacion_id uuid not null references public.conversaciones(id) on delete cascade,

  -- El mensaje SALIENTE que se valoró. `on delete cascade` porque un voto sin
  -- la respuesta que valoró no significa nada.
  mensaje_id      uuid not null references public.mensajes(id) on delete cascade,

  voto            text not null check (voto in ('util','no_util')),

  -- Lo que el vecino contestó cuando se le preguntó qué le faltaba. Sólo tiene
  -- sentido tras un 'no_util', pero no se fuerza por CHECK: si algún día se
  -- pide detalle también tras un pulgar arriba («¿algo más?»), no hace falta
  -- migrar nada.
  comentario      text,

  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

-- Un voto por mensaje. Es lo que hace que tocar el botón dos veces —cosa que
-- pasa: el vecino no ve confirmación inmediata y vuelve a tocar— corrija el
-- voto en vez de contarlo doble e inflar la métrica.
create unique index if not exists valoraciones_mensaje_idx
  on public.valoraciones (mensaje_id);

create index if not exists valoraciones_conversacion_idx
  on public.valoraciones (conversacion_id, creado_en desc);

-- Índice parcial: la consulta que importa es «traeme los pulgares abajo», que
-- es de donde sale el trabajo. Los útiles se cuentan, no se listan.
create index if not exists valoraciones_negativas_idx
  on public.valoraciones (creado_en desc) where voto = 'no_util';

comment on table public.valoraciones is
  'Voto del vecino sobre una respuesta concreta. Un voto por mensaje saliente.';
comment on column public.valoraciones.mensaje_id is
  'El mensaje saliente valorado. El voto se cuelga de la respuesta, no de la charla.';
comment on column public.valoraciones.comentario is
  'Lo que el vecino dijo que le faltaba. El pulgar dice cuantas veces fallo; esto dice que escribir.';

-- ---------------------------------------------------------------------------
-- Registrar un voto
--
-- La escribe el BOT con `service_role`, así que no verifica el padrón: no hay
-- usuario del panel de este lado. Lo que sí hace es resolver contra qué mensaje
-- va el voto, porque el bot sabe la conversación pero no necesariamente el id
-- del mensaje que mandó.
--
-- `p_mensaje_id` null significa «la última respuesta de esta conversación», que
-- es siempre lo que el vecino está valorando cuando toca el botón.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_voto(
  p_conversacion_id uuid,
  p_voto            text,
  p_mensaje_id      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_mensaje uuid;
  v_id uuid;
begin
  if p_voto not in ('util','no_util') then
    raise exception 'voto invalido: %', p_voto;
  end if;

  -- La última respuesta de verdad, no el «¿te sirvió?». Se excluyen los
  -- salientes que ofrecieron el voto: valorar la pregunta de cortesía en vez de
  -- la respuesta dejaría el voto colgado del mensaje equivocado, y el panel
  -- mostraría un pulgar abajo sobre un texto que dice «¿te sirvió?».
  --
  -- ESTE RESPALDO ES EL CAMINO EXCEPCIONAL, no el normal, y el comentario que
  -- estaba acá antes describía algo que el código no hacía.
  --
  -- Decía: «se reconocen por origen_respuesta is null, porque responderCon sólo
  -- pone la traza completa en el PRIMER saliente». Falso: le copiaba
  -- `origenRespuesta` a todos, así que NINGÚN saliente tenía la columna en null
  -- y «el último no nulo» era siempre la propia pregunta de cortesía. El 100% de
  -- los votos habría quedado colgado de ella.
  --
  -- Se arregló en dos capas. La principal: los botones llevan el id del mensaje
  -- valorado (`voto_util:<uuid>`) y el bot lo pasa en `p_mensaje_id`, así que no
  -- hay nada que inferir — y un pulgar tocado veinte minutos después sigue
  -- valorando la respuesta correcta, no la despedida que quedó última. La
  -- secundaria: `responderCon` ahora sí escribe `origen_respuesta = null` en los
  -- salientes de cortesía, así que este respaldo también quedó correcto.
  --
  -- Sigue existiendo porque hay dos casos sin id: el vecino que manda el emoji
  -- suelto en vez de tocar, y los teclados de antes del arreglo, que Telegram
  -- deja vivos para siempre.
  v_mensaje := coalesce(
    p_mensaje_id,
    (select m.id
       from public.mensajes m
      where m.conversacion_id = p_conversacion_id
        and m.direccion = 'saliente'
        and m.origen_respuesta is not null
      order by m.creado_en desc
      limit 1)
  );

  if v_mensaje is null then
    -- Sin respuesta previa no hay nada que valorar. Puede pasar si alguien
    -- toca un botón viejo después de que se borró la conversación.
    return null;
  end if;

  insert into public.valoraciones (conversacion_id, mensaje_id, voto)
  values (p_conversacion_id, v_mensaje, p_voto)
  on conflict (mensaje_id) do update
    set voto = excluded.voto,
        -- Se limpia el comentario al cambiar el voto: un «me faltaba el
        -- horario» pegado a un pulgar ARRIBA no se entiende, y dejarlo sería
        -- peor que perderlo.
        comentario = case when public.valoraciones.voto <> excluded.voto
                          then null else public.valoraciones.comentario end,
        actualizado_en = now()
  returning id into v_id;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Pegarle el comentario al voto
--
-- Va aparte porque llega en un mensaje POSTERIOR: el vecino toca el pulgar
-- abajo y recién después escribe qué le faltaba.
-- ---------------------------------------------------------------------------
create or replace function public.comentar_voto(
  p_conversacion_id uuid,
  p_comentario      text,
  p_ventana_minutos int default 10
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare v_id uuid;
begin
  if coalesce(trim(p_comentario), '') = '' then return false; end if;

  -- El último voto negativo SIN comentario y RECIENTE de esta conversación.
  --
  -- Las tres condiciones importan. Si ya tiene comentario, lo que el vecino
  -- escribe ahora es otra cosa y sobrescribirlo perdería el primero. Y la
  -- ventana de tiempo es lo que evita que un mensaje de mañana quede pegado
  -- como explicación de un pulgar abajo de hoy: sin ella, el bot llamaría a
  -- esta función en cada mensaje y el primer texto que llegara —aunque fuera
  -- una consulta nueva sin relación— se registraría como el detalle del voto.
  --
  -- Que el bot pregunte en cada mensaje, en vez de recordar que hay un voto
  -- esperando, es deliberado: no hay estado que se desincronice ni que se
  -- pierda si Redis se vacía, y la decisión de si el texto corresponde vive en
  -- un solo lugar.
  select id into v_id
    from public.valoraciones
   where conversacion_id = p_conversacion_id
     and voto = 'no_util'
     and comentario is null
     and creado_en > now() - make_interval(mins => greatest(p_ventana_minutos, 0))
   order by creado_en desc
   limit 1;

  if v_id is null then return false; end if;

  update public.valoraciones
     set comentario = trim(p_comentario), actualizado_en = now()
   where id = v_id;

  return true;
end $$;

revoke all on function public.registrar_voto(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.comentar_voto(uuid, text, int) from public, anon, authenticated;

comment on function public.registrar_voto(uuid, text, uuid) is
  'Registra el voto del vecino sobre la ultima respuesta. La llama el bot con service_role.';
comment on function public.comentar_voto(uuid, text, int) is
  'Pega el comentario al ultimo voto negativo sin comentario de esa conversacion.';

-- ---------------------------------------------------------------------------
-- RLS
--
-- El panel LEE. No escribe: el voto es del vecino, y que alguien del municipio
-- pueda cambiarlo destruiría el único dato de esta tabla que vale algo.
-- Tampoco se borra: es la medición de si el servicio sirve.
-- ---------------------------------------------------------------------------
alter table public.valoraciones enable row level security;

drop policy if exists valoraciones_lee_panel on public.valoraciones;
create policy valoraciones_lee_panel on public.valoraciones
  for select to authenticated using (public.es_personal_panel());

-- ---------------------------------------------------------------------------
-- Los textos del voto, editables desde el panel
--
-- `seguimiento_tras_responder` ya existía (020) y se reescribe: antes invitaba
-- a contestar por texto, ahora acompaña a dos botones.
-- ---------------------------------------------------------------------------
insert into public.textos_bot (clave, texto, descripcion, opcional) values
  ('seguimiento_tras_responder',
   '¿Te sirvió esta respuesta?',
   'Se manda como mensaje aparte despues de una respuesta, con los botones de pulgar. Vaciarlo apaga el voto.',
   true),
  ('voto_gracias_util',
   '¡Buenísimo! Cualquier otra cosa que necesites, escribime.',
   'Lo que contesta Migue cuando el vecino vota que la respuesta le sirvio.',
   true),
  ('voto_pedir_detalle',
   'Gracias por decirme, me ayuda a mejorar. ¿Qué te falta saber? Si querés no me contestes, ya lo registré.',
   'Lo que contesta Migue tras un pulgar abajo. Lo que el vecino escriba despues queda pegado al voto.',
   true)
on conflict (clave) do update
  set texto = excluded.texto,
      descripcion = excluded.descripcion,
      opcional = excluded.opcional;

-- ---------------------------------------------------------------------------
-- La vista de conversaciones para el panel
--
-- Existe para que la pantalla no tenga que traerse todos los mensajes de todas
-- las charlas para mostrar una lista. Sin esto, ordenar por «las que no
-- sirvieron primero» obligaría a leer la tabla entera en el cliente.
-- ---------------------------------------------------------------------------
drop view if exists public.v_conversaciones;
create view public.v_conversaciones
with (security_invoker = true) as
  select c.id,
         c.canal,
         c.canal_usuario_id,
         c.nombre_usuario,
         c.estado,
         c.flujo_activo,
         c.cantidad_mensajes,
         c.iniciada_en,
         c.ultima_actividad_en,

         -- El voto resumido. Se cuentan los dos por separado en vez de un
         -- promedio: «2 de 3 sirvieron» dice algo, «0.66» no dice nada, y una
         -- charla con un solo pulgar abajo importa igual que una con tres.
         coalesce(v.utiles, 0)      as votos_utiles,
         coalesce(v.no_utiles, 0)   as votos_no_utiles,
         v.ultimo_comentario,

         -- La primera cosa que preguntó el vecino, para poder reconocer la
         -- charla en una lista sin abrirla. Es más útil que la fecha: nadie
         -- recuerda una conversación por su hora.
         (select m.texto
            from public.mensajes m
           where m.conversacion_id = c.id
             and m.direccion = 'entrante'
             and m.texto is not null
           order by m.creado_en
           limit 1)                as primer_mensaje,

         -- Cuántas de sus preguntas quedaron sin responder. Es la señal que
         -- existe incluso cuando el vecino no votó nada, que va a ser el caso
         -- más frecuente.
         (select count(*)
            from public.sin_respuesta s
           where s.conversacion_id = c.id) as preguntas_sin_responder

    from public.conversaciones c
    left join (
      select conversacion_id,
             count(*) filter (where voto = 'util')     as utiles,
             count(*) filter (where voto = 'no_util')  as no_utiles,
             (array_agg(comentario order by creado_en desc)
                filter (where comentario is not null))[1] as ultimo_comentario
        from public.valoraciones
       group by conversacion_id
    ) v on v.conversacion_id = c.id;

comment on view public.v_conversaciones is
  'Conversaciones con su voto resumido, para la pantalla del panel. security_invoker: hereda el RLS.';

-- ---------------------------------------------------------------------------
-- Y la transcripción, con el voto pegado a cada respuesta
--
-- Es una función y no una vista porque siempre se pide UNA conversación. Una
-- vista sobre todos los mensajes obligaría al panel a filtrar por
-- conversacion_id, y sin el filtro —un error fácil— se traería la bitácora
-- completa del bot.
-- ---------------------------------------------------------------------------
create or replace function public.transcripcion(p_conversacion_id uuid)
returns table (
  id uuid,
  direccion text,
  texto text,
  media_tipo text,
  media_ruta text,
  intencion text,
  confianza numeric,
  origen_respuesta text,
  costo_usd numeric,
  creado_en timestamptz,
  voto text,
  comentario text
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select m.id, m.direccion, m.texto, m.media_tipo, m.media_ruta,
         m.intencion, m.confianza, m.origen_respuesta, m.costo_usd, m.creado_en,
         v.voto, v.comentario
    from public.mensajes m
    left join public.valoraciones v on v.mensaje_id = m.id
   where m.conversacion_id = p_conversacion_id
   order by m.creado_en;
$$;

-- `security invoker`, así que el RLS de `mensajes` se aplica igual y esto NO es
-- una puerta para leer conversaciones sin estar en el padrón. Se le da EXECUTE
-- a `authenticated` porque el panel la usa; a `anon` no, que es la puerta que
-- da a internet.
revoke all on function public.transcripcion(uuid) from public, anon;
grant execute on function public.transcripcion(uuid) to authenticated;

comment on function public.transcripcion(uuid) is
  'Los mensajes de una conversacion con el voto pegado a cada respuesta. security invoker: respeta RLS.';
