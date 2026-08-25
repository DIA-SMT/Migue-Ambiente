-- ===========================================================================
-- 024 · Que la auditoría mire las funciones, no sólo las tablas
-- ===========================================================================
-- SALIÓ DE UN HALLAZGO CONCRETO. En producción hay una función `public.keepalive`
-- que NO está en este repo: PostgREST la expone, y nadie del proyecto la llama.
-- No sabemos qué hace ni quién puede ejecutarla, y no se puede averiguar desde
-- afuera porque Supabase le niega el documento OpenAPI a todo lo que no sea
-- `service_role`.
--
-- Lo importante no es esa función: es que no había forma de enterarse. La 017
-- cerró el agujero de acceso y en su cuarto hallazgo revocó EXECUTE de las
-- funciones abiertas, pero lo hizo con un bucle que filtra `and p.prosecdef`, y
-- eso deja dos huecos:
--
--   1. Las funciones que NO son SECURITY DEFINER se saltearon. Conservan el
--      GRANT a PUBLIC que Postgres pone por default, o sea que `anon` y
--      `authenticated` pueden ejecutarlas. Hoy el daño está acotado porque
--      corren como quien llama y el RLS las contiene — pero es una contención
--      indirecta, no un permiso cerrado.
--
--   2. Nada protege a las funciones creadas DESPUÉS de la 017. Fue una pasada de
--      una sola vez, el 20/08/2026. Cualquier función escrita a mano en el editor
--      de Supabase después de esa fecha nace abierta a PUBLIC.
--
-- Y `v_auditoria_rls`, que es el detector que usa el proyecto, mira políticas de
-- TABLAS. Audita 18 tablas y CERO funciones — justamente la clase de objeto que
-- fue el cuarto hallazgo de la 017.
--
-- Al aplicarla la primera vez, la vista reportó CERO alertas — y estaba mal:
-- había ONCE funciones ejecutables por la clave pública. El detector miraba
-- `proacl is null`, que en Postgres pelado significa «el default abierto» pero
-- en Supabase nunca se da, porque `alter default privileges` lo puebla. La
-- señal correcta es el CONTENIDO del ACL: `anon=X` o `=X/`. Corregido, y la
-- 025 revoca lo que esta vista encontró.
--
-- ESTA MIGRACIÓN NO REVOCA NADA A LAS FUNCIONES QUE YA EXISTEN, y eso es
-- deliberado. Un revoke masivo tendría que repetir a mano las exclusiones que la
-- 017 hizo con cuidado —`es_personal_panel()` y `es_admin_panel()` las evalúa
-- Postgres al aplicar RLS, así que necesitan EXECUTE para `authenticated` y para
-- `anon`, y quitárselas deja a TODO el mundo afuera del panel—. Equivocarse ahí
-- es peor que el problema. Primero el detector; después, con la lista en la mano,
-- se decide función por función.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · Que lo que se cree de acá en adelante nazca cerrado
-- ---------------------------------------------------------------------------
-- Postgres da EXECUTE a PUBLIC por default en cada función nueva. Esto cambia el
-- default para el esquema, así que una función escrita mañana en el editor ya no
-- nace abierta y hay que abrirla a propósito.
--
-- Alcance real, y conviene no exagerarlo: `alter default privileges` aplica a los
-- objetos que cree EL ROL que corre esta sentencia. En el editor de Supabase eso
-- es `postgres`, que es quien crea todo acá. Una función creada por otro rol no
-- queda cubierta — para eso está la vista de abajo.
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 2 · La vista que faltaba
-- ---------------------------------------------------------------------------
-- Hermana de `v_auditoria_rls`, con el mismo contrato: devuelve una fila por
-- objeto y una columna `alerta` que es null cuando está todo bien. Cero filas con
-- alerta = nada que revisar.
--
-- Se lee con `service_role` desde el arnés de pruebas y con una sesión de panel
-- desde la pantalla de Personal, cuando exista.
drop view if exists public.v_auditoria_funciones;

create view public.v_auditoria_funciones
with (security_invoker = true) as
  select p.oid::regprocedure::text                        as firma,
         p.proname                                         as nombre,
         p.prosecdef                                       as es_security_definer,
         case p.provolatile
           when 'i' then 'immutable'
           when 's' then 'stable'
           else 'volatile'
         end                                               as volatilidad,
         -- LA SEÑAL DE PELIGRO NO ES `proacl is null`, y la primera versión de
         -- esta vista se equivocó justo en eso: reportó CERO alertas mientras
         -- había ONCE funciones ejecutables por la clave pública.
         --
         -- En Postgres pelado, una función nueva tiene `proacl` en null y eso
         -- significa «el default», que incluye EXECUTE para PUBLIC. Pero Supabase
         -- configura `alter default privileges` en el esquema, así que `proacl`
         -- viene POBLADO —con anon, authenticated y service_role adentro— y nunca
         -- es null. El detector miraba una condición que en esta base no se da.
         --
         -- Lo que hay que leer es el contenido del ACL: `=X/` con el destinatario
         -- vacío es PUBLIC, y `anon=X` es la clave pública, que está en el
         -- JavaScript del panel y la tiene cualquiera.
         -- El ACL es un array de entradas «destinatario=privilegios/otorgante».
         -- Una entrada que ARRANCA con `=` tiene el destinatario vacío, y eso es
         -- PUBLIC. Se busca `{=X` (primera entrada) o `,=X` (cualquier otra) para
         -- no confundirla con `anon=X`, que también contiene un `=X`.
         coalesce(
           p.proacl::text like '{=X%' or p.proacl::text like '%,=X%',
           true            -- proacl en null es el default de Postgres: PUBLIC
         )                                                 as ejecutable_por_public,
         coalesce(
           p.proacl::text like '%anon=X%'
             or p.proacl::text like '{=X%' or p.proacl::text like '%,=X%',
           true
         )                                                 as ejecutable_por_anon,
         p.proacl::text                                    as permisos,
         pg_get_userbyid(p.proowner)                       as dueno,
         -- Si está en el repo o apareció por otro lado. No se puede saber desde
         -- la base, así que se marca lo que sí se puede: tener un comentario es
         -- la convención del proyecto para las funciones propias.
         obj_description(p.oid, 'pg_proc') is not null      as tiene_comentario,

         case
           -- Estas dos SÍ tienen que ser ejecutables por `anon`. Postgres las
           -- evalúa al aplicar RLS, así que necesitan EXECUTE para todo rol que
           -- consulte una tabla protegida; quitárselas deja a TODO el mundo
           -- afuera del panel. La 017 lo dejó escrito y las excluyó de su revoke
           -- a propósito.
           --
           -- La excepción va PRIMERA en el `case` y no al final, porque si no
           -- caen en las ramas de abajo y la vista devuelve dos alertas
           -- permanentes. Una auditoría con ruido de fondo esconde el hallazgo
           -- real: es el mismo error de la primera `v_auditoria_rls`, que contaba
           -- políticas y decía «1 política» sobre diez tablas con `using (true)`.
           when p.proname in ('es_personal_panel', 'es_admin_panel') then null

           -- El patrón exacto que la 017 vino a cerrar: corre con los permisos
           -- del dueño, saltea RLS, y cualquiera puede llamarla.
           when p.prosecdef and coalesce(
                  p.proacl::text like '%anon=X%'
                    or p.proacl::text like '{=X%' or p.proacl::text like '%,=X%',
                  true) then
             'CRITICO: security definer ejecutable por la clave publica. Saltea RLS.'
           -- Abierta pero sin bypass: la contiene el RLS, no el permiso. Es una
           -- contención indirecta y vale cerrarla igual.
           when coalesce(
                  p.proacl::text like '%anon=X%'
                    or p.proacl::text like '{=X%' or p.proacl::text like '%,=X%',
                  true) then
             'ABIERTA: la puede llamar cualquiera con la clave publica. La contiene el RLS.'
           else null
         end                                               as alerta

    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     -- Las que pertenecen a una extensión no son nuestras: pgcrypto, pg_trgm y
     -- unaccent traen decenas y sus permisos los define la extensión.
     and not exists (
       select 1 from pg_depend d
        where d.objid = p.oid and d.deptype = 'e'
     );

comment on view public.v_auditoria_funciones is
  'Una fila por funcion de public, con su alerta. Cero filas con alerta no nula = nada que revisar. Hermana de v_auditoria_rls, que solo mira tablas.';

-- La vista expone nombres de funciones y permisos: el mapa de la superficie
-- ejecutable. Con `security_invoker` hereda los privilegios del que consulta,
-- pero `pg_proc` es legible por todos, así que la cerradura tiene que ser el
-- GRANT y no la vista.
revoke all on public.v_auditoria_funciones from public, anon;
grant select on public.v_auditoria_funciones to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3 · Y que la auditoría de tablas también deje de estar abierta
-- ---------------------------------------------------------------------------
-- `v_auditoria_rls` entrega el inventario de las tablas del sistema y el
-- predicado exacto que protege cada una. La 023 ya le revocó el acceso a `anon`;
-- se repite acá con `if exists` para que esta migración deje el esquema en el
-- estado correcto si se aplica sobre una base donde la 023 no corrió.
do $$
begin
  if to_regclass('public.v_auditoria_rls') is not null then
    execute 'revoke all on public.v_auditoria_rls from public, anon';
    execute 'grant select on public.v_auditoria_rls to authenticated, service_role';
  end if;
end $$;
