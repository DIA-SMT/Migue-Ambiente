-- ===========================================================================
-- 029 · El voto se cierra con el primer toque
-- ===========================================================================
-- SALIÓ DE PROBAR EL BOT. Apareció la encuesta, se votó, y se podía seguir
-- votando: 👍 👎 👍 👎, y Migue agradecía cada vez.
--
-- Eran dos problemas encimados, y uno solo se arregla acá:
--
--   1. `registrar_voto` hacía `on conflict (mensaje_id) do update`, así que cada
--      toque SOBREESCRIBÍA el voto anterior. Nunca hubo filas duplicadas —eso ya
--      estaba cubierto— pero el valor cambiaba, y el bot volvía a contestar.
--   2. Los botones de Telegram quedan vivos para siempre. Eso se arregla en el
--      adaptador, quitando el teclado después del primer toque.
--
-- Esta migración hace lo primero: el PRIMER toque gana y los siguientes no
-- cambian nada.
--
-- LO QUE SE PIERDE, dicho de frente: hasta ahora un vecino que tocaba 👎 por
-- error podía corregirse. Desde acá no. Se elige igual porque el dato que le
-- sirve al área es la primera reacción, no la última de una serie de toques —y
-- porque un botón que responde siempre lo mismo no le enseña al vecino que su
-- voto quedó tomado—. La válvula de escape existe: tras un 👎 Migue pregunta qué
-- faltó, y ahí el vecino puede escribir «me equivoqué», que el área lee en el
-- comentario.
--
-- Y hay un efecto lateral bueno. `creado_en` ya no se mueve con cada toque, así
-- que la ventana de 10 minutos de `comentar_voto` queda anclada al momento real
-- del voto. Antes, tocar el botón de nuevo estiraba la ventana y un texto muy
-- posterior podía quedar pegado como explicación.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · El primer toque gana
-- ---------------------------------------------------------------------------
-- La función ahora devuelve un objeto y no un uuid, porque el bot necesita
-- distinguir tres desenlaces que antes se veían iguales:
--
--   {"id": "...", "ya_habia_votado": false}  se registró ahora  -> agradecer
--   {"id": "...", "ya_habia_votado": true}   ya estaba          -> callarse
--   {"id": null,  "ya_habia_votado": false}  no había qué votar -> callarse
--
-- Sin el segundo caso el bot no puede callarse en el momento correcto: o
-- agradece de nuevo (lo que se está arreglando) o no agradece nunca.
--
-- Se barren todas las sobrecargas por nombre. Es la regla del proyecto y ya me
-- falló una vez en la 028: dropear la firma vieja a mano deja la migración
-- funcionando en la primera pasada y explotando en la segunda. Acá además CAMBIA
-- el tipo de retorno, y para eso `create or replace` no alcanza ni con la misma
-- firma: Postgres rechaza cambiar el tipo devuelto.
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
returns jsonb
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
  -- conversación es para el emoji suelto y los teclados viejos, que Telegram
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
    return jsonb_build_object('id', null, 'ya_habia_votado', false);
  end if;

  insert into public.valoraciones (conversacion_id, mensaje_id, voto, sobre)
  values (p_conversacion_id, v_mensaje, p_voto, p_sobre)
  on conflict (mensaje_id) do nothing
  returning id into v_id;

  -- `do nothing` no devuelve fila cuando ya existía. Eso —y no un select previo—
  -- es lo que hace la operación atómica: dos toques simultáneos no pueden
  -- ver los dos «todavía no hay voto» y pisarse.
  if v_id is null then
    select id into v_id
      from public.valoraciones
     where mensaje_id = v_mensaje;
    return jsonb_build_object('id', v_id, 'ya_habia_votado', true);
  end if;

  return jsonb_build_object('id', v_id, 'ya_habia_votado', false);
end $$;

comment on function public.registrar_voto(uuid, text, uuid, text) is
  'Registra el voto del vecino. El PRIMER toque gana: los siguientes devuelven ya_habia_votado=true y no cambian nada. Devuelve {"id":uuid|null,"ya_habia_votado":bool} para que el bot sepa si agradecer o callarse.';

revoke all on function public.registrar_voto(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.registrar_voto(uuid, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2 · Y la constancia de que fue una decisión, no un descuido
-- ---------------------------------------------------------------------------
comment on column public.valoraciones.voto is
  'util | no_util. NO se corrige: el primer toque gana (029). Un vecino que se equivoco puede decirlo en el comentario, que es lo que el area lee.';
