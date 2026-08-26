-- ===========================================================================
-- 031 · La encuesta al final de la charla, no después de cada respuesta
-- ===========================================================================
-- Hasta acá Migue preguntaba «¿te sirvió esta respuesta?» pegado a CADA
-- respuesta. Funcionaba, pero mide lo que no importa y molesta: alguien que
-- pregunta tres cosas recibe tres encuestas, y ninguna dice si se fue con el
-- problema resuelto — que es la única pregunta que le sirve al área.
--
-- Ahora se pregunta UNA vez, cuando la charla se apagó. El corte es por
-- silencio: si pasaron N minutos sin que nadie escriba, la conversación
-- terminó. No hace falta que el vecino se despida, y de hecho la mayoría no lo
-- hace: deja de contestar y listo.
--
-- POR QUÉ UNA COLUMNA Y NO UNA COLA. La alternativa era encolar un trabajo
-- «mandar encuesta a las 14:32». Se descartó por dos motivos: la cola la
-- consume el worker, que sabe bajar fotos pero no mandar mensajes; y un trabajo
-- programado hay que cancelarlo o reprogramarlo cada vez que el vecino vuelve a
-- escribir, que es la parte que se rompe. Con una marca en la conversación, la
-- consulta pregunta por el estado actual y no hay nada que cancelar: si el
-- vecino escribió recién, la conversación deja de estar en silencio y se cae
-- sola de la lista.
-- ===========================================================================

alter table public.conversaciones
  add column if not exists encuesta_enviada_en timestamptz;

comment on column public.conversaciones.encuesta_enviada_en is
  'Cuándo se mandó la encuesta de cierre. Null = todavía no. Evita repetirla si el vecino vuelve a escribir y se calla de nuevo.';

-- Sirve al barrido: busca conversaciones abiertas, sin encuestar, ordenadas por
-- actividad. El índice parcial lo hace barato aunque la tabla crezca.
create index if not exists conversaciones_sin_encuestar_idx
  on public.conversaciones (ultima_actividad_en)
  where encuesta_enviada_en is null and estado = 'abierta';

-- ---------------------------------------------------------------------------
-- Cuánto silencio cuenta como «se terminó»
-- ---------------------------------------------------------------------------
-- Editable desde el panel, como todo lo demás. Un minuto es corto a propósito
-- para probar; en producción con tráfico real conviene subirlo, porque alguien
-- que tarda dos minutos en escribir la dirección no terminó la charla.
insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('encuesta_final_minutos', '1'::jsonb,
   'Minutos de silencio tras los que Migue pregunta si le sirvió. En 0 se apaga la encuesta de cierre.',
   'negocio')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- Quiénes tienen que recibirla
-- ---------------------------------------------------------------------------
-- Va como función en la base y no como consulta armada en el bot por una razón
-- concreta: son cuatro condiciones y tres de ellas son fáciles de olvidar. Acá
-- quedan escritas una vez, con el motivo de cada una al lado.
create or replace function public.conversaciones_para_encuestar(
  p_minutos int,
  p_limite  int default 20
)
returns table (
  id               uuid,
  canal            text,
  canal_usuario_id text
)
language sql
security definer
set search_path = public
as $$
  select c.id, c.canal, c.canal_usuario_id
    from public.conversaciones c
   where c.estado = 'abierta'
     and c.encuesta_enviada_en is null
     -- Silencio suficiente.
     and c.ultima_actividad_en < now() - make_interval(mins => p_minutos)
     -- Y no tanto silencio como para que preguntar sea raro. Sin este techo, al
     -- activar la función el bot le escribiría de golpe a todos los vecinos que
     -- pasaron alguna vez, meses después.
     and c.ultima_actividad_en > now() - interval '24 hours'
     -- Hubo una respuesta de verdad: si sólo dijo «hola» y se fue, no hay nada
     -- que valorar y preguntarlo es ruido.
     and exists (
       select 1 from public.mensajes m
        where m.conversacion_id = c.id
          and m.direccion = 'saliente'
          and m.origen_respuesta in ('faq','documentos','respuesta_fija','exclusion')
     )
     -- Y todavía no votó nada en esta charla.
     and not exists (
       select 1 from public.valoraciones v where v.conversacion_id = c.id
     )
   order by c.ultima_actividad_en
   limit p_limite;
$$;

comment on function public.conversaciones_para_encuestar(int, int) is
  'Conversaciones en silencio que merecen la encuesta de cierre. Las cuatro condiciones están comentadas en el cuerpo.';

revoke all on function public.conversaciones_para_encuestar(int, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Marcarla como enviada
-- ---------------------------------------------------------------------------
-- Devuelve si marcó o no. El bot manda el mensaje SÓLO si esto devolvió true,
-- así dos barridos simultáneos no pueden mandar la encuesta dos veces: el
-- segundo ve la columna ya escrita y no marca nada.
create or replace function public.marcar_encuesta_enviada(p_conversacion uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  with tocada as (
    update public.conversaciones
       set encuesta_enviada_en = now()
     where id = p_conversacion
       and encuesta_enviada_en is null
    returning 1
  )
  select exists (select 1 from tocada);
$$;

comment on function public.marcar_encuesta_enviada(uuid) is
  'Marca la encuesta como enviada. Devuelve false si ya estaba marcada: es el candado contra el envío doble.';

revoke all on function public.marcar_encuesta_enviada(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- El texto de la encuesta de cierre
-- ---------------------------------------------------------------------------
insert into public.textos_bot (clave, texto, descripcion, opcional) values
  ('encuesta_cierre',
   '¿Pudiste resolver lo que necesitabas?',
   'Se manda una sola vez, cuando la charla lleva un rato en silencio, con los botones de pulgar. Vaciarlo apaga la encuesta de cierre.',
   true)
on conflict (clave) do nothing;
