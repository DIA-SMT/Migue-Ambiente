-- ===========================================================================
-- 028 · Preguntar cómo le resultó el trámite
-- ===========================================================================
-- SALIÓ DE PROBAR EL BOT. Se completó un pedido de retiro entero —cinco pasos,
-- una foto, la dirección, «✅ Solicitud registrada»— y el bot no preguntó nada.
-- El voto sólo aparecía después de una RESPUESTA, y un trámite no es una
-- respuesta.
--
-- Y es justo el momento en que más conviene preguntar: el vecino acaba de pasar
-- por cinco preguntas y sabe mejor que nadie si el camino fue claro.
--
-- PERO NO ES LA MISMA PREGUNTA, y eso es lo que hace que valga una migración en
-- lugar de reusar la que ya está:
--
--   «¿Te sirvió esta respuesta?»   mide si el CONTENIDO era el correcto. Un
--                                  pulgar abajo se arregla escribiendo una
--                                  respuesta mejor.
--   «¿Te resultó fácil?»           mide si el PROCESO fue claro. Un pulgar abajo
--                                  se arregla cambiando los textos del flujo, o
--                                  sacando un paso.
--
-- Los dos arreglos son distintos y los hace gente distinta. Mezclarlos en la
-- misma métrica deja al área con un número que no le dice qué hacer — que es
-- exactamente el problema que este proyecto viene corrigiendo en otras cinco
-- partes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · Sobre QUÉ es el voto
-- ---------------------------------------------------------------------------
-- Una columna y no una inferencia. Se podría deducir del `origen_respuesta` del
-- mensaje votado —los pasos de un trámite son 'flujo' y las respuestas no— pero
-- este proyecto ya se quemó una vez confiando en esa columna para esto: el voto
-- entero quedaba colgado del mensaje equivocado porque `responderCon` la llenaba
-- en todos los salientes. Un dato explícito no se puede leer mal.
alter table public.valoraciones
  add column if not exists sobre text not null default 'respuesta'
    check (sobre in ('respuesta', 'tramite'));

comment on column public.valoraciones.sobre is
  'respuesta = «te sirvio lo que te conteste», se arregla escribiendo mejor. tramite = «te resulto facil el pedido», se arregla cambiando los pasos o los textos del flujo. Son arreglos distintos y los hace gente distinta.';

-- `registrar_voto` recibe sobre qué es. Por defecto 'respuesta', así que la
-- llamada que ya existe en el bot sigue funcionando sin cambios.
--
-- Se dropean TODAS las sobrecargas por nombre, no la firma vieja a mano. Mi
-- primera versión dropeaba `(uuid, text, uuid)` y creaba `(uuid, text, uuid,
-- text)`: la primera pasada andaba y la SEGUNDA fallaba con «function
-- registrar_voto already exists with same argument types». Es la regla del
-- proyecto que ya me falló antes —`create function` no tiene IF NOT EXISTS, y
-- `create or replace` con una firma distinta crea una sobrecarga en lugar de
-- reemplazar— y la única forma de que una migración sea idempotente de verdad es
-- barrer por nombre.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'registrar_voto'
  loop
    execute format('drop function if exists %s cascade', r.firma);
  end loop;
end $$;

create function public.registrar_voto(
  p_conversacion_id uuid,
  p_voto            text,
  p_mensaje_id      uuid default null,
  p_sobre           text default 'respuesta'
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
  if p_voto not in ('util', 'no_util') then
    raise exception 'voto invalido: %', p_voto;
  end if;
  if p_sobre not in ('respuesta', 'tramite') then
    raise exception 'sobre invalido: %', p_sobre;
  end if;

  -- El camino normal es que el botón traiga el mensaje. El respaldo por
  -- conversación es para el emoji suelto y los teclados viejos, que Telegram deja
  -- vivos para siempre.
  --
  -- El comentario que estaba acá antes decía que los salientes de cortesía «se
  -- reconocen por origen_respuesta is null» y era falso: `responderCon` llenaba
  -- la columna en todos, así que «el último no nulo» era la propia pregunta
  -- «¿te sirvió?» y el 100% de los votos habría quedado colgado de ella. Se
  -- arregló en las dos capas: los botones llevan el id, y `responderCon` ahora
  -- sí deja la columna en null en los salientes de cortesía.
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
    return null;
  end if;

  insert into public.valoraciones (conversacion_id, mensaje_id, voto, sobre)
  values (p_conversacion_id, v_mensaje, p_voto, p_sobre)
  on conflict (mensaje_id) do update
    set voto = excluded.voto,
        sobre = excluded.sobre,
        -- Cambiar el voto limpia el comentario: explicaba el voto anterior y
        -- dejarlo pegado al nuevo lo hace decir algo que el vecino no dijo.
        comentario = null,
        creado_en = now()
  returning id into v_id;

  return v_id;
end $$;

comment on function public.registrar_voto(uuid, text, uuid, text) is
  'Registra el voto del vecino. `p_mensaje_id` viene del boton y es el camino normal; sin el, cae a un respaldo por conversacion. `p_sobre` distingue si califica una respuesta o un tramite.';

revoke all on function public.registrar_voto(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.registrar_voto(uuid, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2 · Los textos, editables desde el panel
-- ---------------------------------------------------------------------------
-- Vaciar el primero apaga la encuesta del trámite sin tocar la de las
-- respuestas, y sin un deploy. Es la misma puerta que tiene el voto de
-- respuestas.
insert into public.textos_bot (clave, texto, descripcion, opcional) values
  ('seguimiento_tras_tramite',
   '¿Te resultó fácil hacer el pedido?',
   'Se manda como mensaje aparte despues de completar un tramite, con los botones de pulgar. Mide si el PROCESO fue claro, no si la respuesta era correcta. Vaciarlo apaga esta encuesta sin apagar la de las respuestas.',
   true),

  ('voto_tramite_detalle',
   E'Gracias por decirme. ¿Qué te resultó complicado? Con eso podemos simplificarlo.\n\nSi querés no me contestes, ya lo registré.',
   'Se manda cuando el vecino dice que el tramite NO le resulto facil. Pregunta por el PROCESO, no por la respuesta: «que te falta saber» no aplica acá.',
   true)
on conflict (clave) do update
  set descripcion = excluded.descripcion,
      opcional = excluded.opcional;

-- ---------------------------------------------------------------------------
-- 3 · Y que el panel pueda separarlos
-- ---------------------------------------------------------------------------
-- `v_conversaciones` cuenta los votos sin distinguir. Con las dos clases
-- mezcladas, un «60% le sirvió» junta dos cosas que se arreglan distinto.
drop view if exists public.v_conversaciones;

create view public.v_conversaciones
with (security_invoker = true) as
  select c.id,
         c.canal,
         -- `canal_usuario_id` NO va acá: en WhatsApp es el teléfono del vecino y
         -- ningún componente del panel lo usa. Lo sacó la 023.
         c.nombre_usuario,
         c.estado,
         c.flujo_activo,
         c.cantidad_mensajes,
         c.iniciada_en,
         c.ultima_actividad_en,

         coalesce(v.utiles, 0)              as votos_utiles,
         coalesce(v.no_utiles, 0)           as votos_no_utiles,
         -- Separados por lo que califican, porque los arreglos son distintos:
         -- una respuesta mala se corrige escribiendo; un trámite difícil se
         -- corrige cambiando los pasos.
         coalesce(v.respuesta_mala, 0)      as votos_respuesta_mala,
         coalesce(v.tramite_dificil, 0)     as votos_tramite_dificil,
         v.ultimo_comentario,

         (select m.texto
            from public.mensajes m
           where m.conversacion_id = c.id
             and m.direccion = 'entrante'
             and m.texto is not null
           order by m.creado_en
           limit 1)                        as primer_mensaje,

         (select count(*)
            from public.sin_respuesta s
           where s.conversacion_id = c.id
             and s.estado = 'pendiente')    as preguntas_pendientes,

         (select count(*)
            from public.sin_respuesta s
           where s.conversacion_id = c.id)  as preguntas_falladas

    from public.conversaciones c
    left join (
      select conversacion_id,
             count(*) filter (where voto = 'util')     as utiles,
             count(*) filter (where voto = 'no_util')  as no_utiles,
             count(*) filter (where voto = 'no_util' and sobre = 'respuesta')
               as respuesta_mala,
             count(*) filter (where voto = 'no_util' and sobre = 'tramite')
               as tramite_dificil,
             (array_agg(comentario order by creado_en desc)
                filter (where comentario is not null))[1] as ultimo_comentario
        from public.valoraciones
       group by conversacion_id
    ) v on v.conversacion_id = c.id;

comment on view public.v_conversaciones is
  'Conversaciones con su voto resumido, separando lo que califica una respuesta de lo que califica un tramite. security_invoker: hereda el RLS. No expone canal_usuario_id.';

revoke all on public.v_conversaciones from anon;
grant select on public.v_conversaciones to authenticated, service_role;
