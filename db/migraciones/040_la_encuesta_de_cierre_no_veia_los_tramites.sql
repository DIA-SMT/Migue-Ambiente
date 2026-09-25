-- ===========================================================================
-- 040 · La encuesta de cierre no le llegaba a quien hizo un trámite
-- ===========================================================================
-- `conversaciones_para_encuestar` (031) exige que en la charla haya habido «una
-- respuesta de verdad» antes de preguntar si sirvió. La idea es buena: a quien
-- dijo «hola» y se fue no hay nada que preguntarle.
--
-- Pero «de verdad» se definió como una respuesta de la cadena de conocimiento:
--
--     origen_respuesta in ('faq','documentos','respuesta_fija','exclusion')
--
-- y ahí falta `flujo`, que es TODO lo que el bot dice durante un trámite:
-- pedir la foto, pedir la dirección, confirmar el pedido con su fecha. O sea
-- que el vecino que completó un retiro —la interacción que más nos interesa
-- medir— nunca recibía la encuesta. Sólo la recibía quien hizo una consulta.
--
-- Medido en producción el 2026-09-25, sobre los salientes de toda la base:
--
--     flujo 31 · null 14 · fallback 3 · exclusion 2 · respuesta_fija 2
--
-- Las cuatro conversaciones de prueba de ese día, todas de trámite, daban cero
-- en la función aunque cumplían las otras cuatro condiciones: abiertas, sin
-- encuesta enviada, en silencio hacía quince minutos y sin voto previo. En un
-- mes la encuesta había salido dos veces, las dos en charlas de consulta.
--
-- LO QUE NO SE AGREGA, Y ES A PROPÓSITO
--
-- `fallback` —el «no tengo esa información con la certeza suficiente»— sigue
-- afuera. Preguntarle «¿pudiste resolver lo que necesitabas?» a alguien a quien
-- se le acaba de admitir que no se sabía es sal en la herida, y el voto no
-- agregaría nada: esa falla ya quedó registrada en `sin_respuesta`. Es el mismo
-- criterio que usa el orquestador para no ofrecer los pulgares tras un
-- `sin_respuesta`.
--
-- `null` tampoco: son los salientes sin traza, como el menú.
-- ===========================================================================

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
     -- Hubo algo que valorar: una respuesta de la cadena de conocimiento, una
     -- derivación, o un TRÁMITE. Lo último faltaba y es lo que más se usa.
     and exists (
       select 1 from public.mensajes m
        where m.conversacion_id = c.id
          and m.direccion = 'saliente'
          and m.origen_respuesta in ('faq','documentos','respuesta_fija','exclusion','flujo')
     )
     -- Y todavía no votó nada en esta charla.
     and not exists (
       select 1 from public.valoraciones v where v.conversacion_id = c.id
     )
   order by c.ultima_actividad_en
   limit p_limite;
$$;

comment on function public.conversaciones_para_encuestar(int, int) is
  'Conversaciones en silencio que merecen la encuesta de cierre. Las cinco condiciones estan comentadas en el cuerpo. Un tramite (origen flujo) cuenta como respuesta valorable; un fallback no.';

-- `create or replace` conserva los permisos, pero se repite para que la
-- migracion sea legible sola: esta funcion no la ejecuta nadie desde el
-- navegador, sólo el bot con la service_role.
revoke all on function public.conversaciones_para_encuestar(int, int) from public, anon, authenticated;
