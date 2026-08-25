-- ===========================================================================
-- 023 · Dos arreglos en `v_conversaciones`
-- ===========================================================================
-- Los dos salieron de una revisión adversarial de la 022, y los dos son del tipo
-- que no se nota: la pantalla funciona, muestra números, y los números no
-- significan lo que dicen.
--
-- 1 · «DONDE ALGO FALLÓ» NUNCA BAJABA
--
-- `preguntas_sin_responder` contaba TODAS las filas de `sin_respuesta` de la
-- conversación, sin mirar `estado`. Una pregunta que alguien ya resolvió
-- —escribió la respuesta, la publicó, el vecino que vuelva a preguntar ya recibe
-- algo— seguía contando igual. El filtro «Donde falló algo» del panel es
-- monótono creciente: hacer el trabajo no lo baja.
--
-- Es exactamente la forma del bug que este proyecto ya tuvo con los tickets: dos
-- lugares preguntaban «¿esto está cerrado?» de maneras distintas y la misma
-- pantalla decía «20 abiertos» y «13 vencidos» sobre las mismas filas. Se
-- arregló unificando en un solo helper, `estaCerrado()`.
--
-- Acá se parte en dos columnas con nombres que dicen qué son, en vez de una que
-- se pueda leer de las dos formas:
--
--   preguntas_pendientes  las que todavía nadie resolvió. Es la accionable, la
--                         que baja cuando el área trabaja.
--   preguntas_falladas    todas las que alguna vez fallaron, resueltas
--                         incluidas. Es historia y no una tarea; sirve para no
--                         perder de vista que esa charla salió mal aunque ya se
--                         haya arreglado.
--
-- 2 · EL IDENTIFICADOR DEL VECINO SALÍA A LA VISTA SIN QUE NADIE LO USE
--
-- `canal_usuario_id` estaba en el select. En Telegram es el chat id; en WhatsApp
-- —a donde este bot va a migrar— es EL TELÉFONO del vecino. Ningún componente
-- del panel lo lee: viajaba a cada navegador que abre la lista, quedaba en el
-- HTML, en la caché y en cualquier captura de pantalla, sin habilitar ninguna
-- funcionalidad.
--
-- El criterio es el mismo que la 018 aplicó cuando una vista con
-- `security_invoker` iba a exponer los correos del padrón: RLS es por FILA y no
-- por COLUMNA, así que lo único que evita que una columna se lea es no
-- seleccionarla. Se saca. Si algún día hace falta identificar al vecino desde el
-- panel, va por una función que devuelva sólo lo necesario.
--
-- La conversación se sigue reconociendo por `nombre_usuario` y por
-- `primer_mensaje`, que es lo que el panel realmente muestra.
-- ===========================================================================

drop view if exists public.v_conversaciones;

create view public.v_conversaciones
with (security_invoker = true) as
  select c.id,
         c.canal,
         -- `canal_usuario_id` NO va acá. Ver el encabezado: en WhatsApp es el
         -- teléfono del vecino y ningún componente lo usa.
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

         -- Lo que todavía hay que hacer. Baja cuando alguien escribe la
         -- respuesta, que es lo que se espera de un número accionable.
         (select count(*)
            from public.sin_respuesta s
           where s.conversacion_id = c.id
             and s.estado = 'pendiente') as preguntas_pendientes,

         -- Lo que alguna vez falló, ya resuelto o descartado incluido. Es
         -- historia, no tarea. Se expone aparte y con otro nombre a propósito:
         -- una sola columna que se pueda leer de las dos maneras es cómo nació
         -- el bug que esta migración arregla.
         (select count(*)
            from public.sin_respuesta s
           where s.conversacion_id = c.id) as preguntas_falladas

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
  'Conversaciones con su voto resumido. security_invoker: hereda el RLS. No expone canal_usuario_id: en WhatsApp es el telefono del vecino y el panel no lo usa.';

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
-- `anon` conservaba el GRANT de SELECT que Supabase da por defecto a toda tabla
-- y vista nueva del esquema `public`. No se filtraba nada —`security_invoker`
-- hace que la vista corra con los permisos de quien la consulta, y `anon` no
-- pasa el RLS de `conversaciones`— pero la separación entre la clave pública y
-- las charlas de todos los vecinos quedaba dependiendo de una sola palabra en
-- una línea, sin nada que la respalde.
--
-- Con el REVOKE hay dos cerraduras independientes. Y `v_auditoria_rls`, que es
-- el detector que usa el proyecto para encontrar agujeros, mira políticas de
-- TABLAS y no ve vistas: si alguien recreara esta vista sin `security_invoker`,
-- la auditoría no diría nada. El REVOKE sí lo atajaría.
revoke all on public.v_conversaciones from anon;
grant select on public.v_conversaciones to authenticated, service_role;

-- Mismo criterio para las otras dos vistas que el panel usa. `v_auditoria_rls`
-- es el caso más claro: entrega el inventario completo de tablas y el predicado
-- exacto que protege cada una, y la clave anon es pública por diseño —está en el
-- JavaScript del panel, la lee cualquiera—.
do $$
begin
  if to_regclass('public.v_auditoria_rls') is not null then
    execute 'revoke all on public.v_auditoria_rls from anon, public';
    execute 'grant select on public.v_auditoria_rls to authenticated, service_role';
  end if;
  if to_regclass('public.v_sin_respuesta') is not null then
    execute 'revoke all on public.v_sin_respuesta from anon';
    execute 'grant select on public.v_sin_respuesta to authenticated, service_role';
  end if;
end $$;
