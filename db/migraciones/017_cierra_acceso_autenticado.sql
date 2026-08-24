-- ===========================================================================
-- 017 · Cierra el acceso de «cualquier usuario autenticado»
-- ===========================================================================
-- QUÉ SE ENCONTRÓ, verificado contra el proyecto en vivo el 20/08/2026:
--
--   1. La migración 007 dejó `using (true)` para el rol `authenticated` en las
--      cinco tablas con datos de vecinos y en las diez de contenido. El único
--      requisito para leer, modificar y borrar era ESTAR LOGUEADO: sin chequeo
--      de rol, de dominio de correo, ni de nada.
--
--   2. `disable_signup` estaba en false en Supabase Auth, o sea que el registro
--      público estaba habilitado. Cualquiera podía crearse una cuenta con su
--      propio correo, confirmarla en su propia casilla y quedar dentro del rol
--      `authenticated`.
--
--   3. Con eso la cadena se cerraba sola: 19 tickets con la dirección real de
--      un vecino en 18 de ellos, más la capacidad de reescribir `textos_bot` y
--      cambiar qué le dice el bot municipal a la gente.
--
--   4. Cuatro funciones `security definer` quedaron con EXECUTE para PUBLIC,
--      que es el default de Postgres, y no había un solo REVOKE en todo el
--      repositorio. PostgREST publica toda función del esquema `public` como
--      RPC, y al ser `security definer` corren por encima del RLS. Una de ellas
--      —`agrupar_sin_respuesta`— hace INSERT.
--
-- La 007 se escribió para cerrar exactamente esta fuga con el rol `anon`, y lo
-- logró. Lo que no vio es que la dejó abierta un escalón más arriba. La lección
-- para el proyecto: «RLS activo» no es lo mismo que «RLS que restringe», y la
-- vista `v_auditoria_rls` contaba políticas sin mirar qué permitían. Al final
-- de este archivo se la reemplaza por una que sí mira.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Quiénes son «el personal del panel»
--
-- Una lista explícita en vez de una regla sobre el correo. Con una regla de
-- dominio no se puede sacar a una persona sin sacar a todas, y acá hace falta
-- poder dar de baja a alguien el día que deja el área.
--
-- `activo` en lugar de borrar la fila: el registro de quién tuvo acceso y
-- cuándo es parte de la respuesta a un pedido de datos personales.
-- ---------------------------------------------------------------------------
create table if not exists public.personal_panel (
  usuario_id  uuid primary key references auth.users(id) on delete cascade,
  correo      text        not null,
  nombre      text,
  rol         text        not null default 'operador'
                check (rol in ('operador','supervisor','admin')),
  activo      boolean     not null default true,
  creado_en   timestamptz not null default now(),
  creado_por  uuid,
  notas       text
);

comment on table public.personal_panel is
  'Personas del municipio habilitadas a usar el panel. Estar en auth.users NO alcanza.';

create index if not exists personal_panel_activo_idx
  on public.personal_panel (usuario_id) where activo;

alter table public.personal_panel enable row level security;

-- ---------------------------------------------------------------------------
-- El predicado que reemplaza a `using (true)`
--
-- Va en una función para que la condición esté escrita UNA vez: repetirla en
-- treinta políticas es garantizar que alguna quede distinta en el próximo
-- cambio.
--
-- `security definer` es necesario acá: la política de una tabla tiene que poder
-- leer `personal_panel`, y esa tabla también tiene RLS. Sin definer, la
-- consulta se filtraría a sí misma y nadie entraría nunca.
--
-- `search_path` fijo y `revoke` más abajo: son las dos precauciones que hay que
-- tomar siempre que se escribe un definer, y la 013 y la 014 se olvidaron de la
-- segunda.
-- ---------------------------------------------------------------------------
create or replace function public.es_personal_panel()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.personal_panel
     where usuario_id = auth.uid()
       and activo
  );
$$;

comment on function public.es_personal_panel() is
  'true si quien consulta es personal municipal habilitado y activo.';

create or replace function public.es_admin_panel()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.personal_panel
     where usuario_id = auth.uid()
       and activo
       and rol in ('admin','supervisor')
  );
$$;

comment on function public.es_admin_panel() is
  'true si quien consulta puede además administrar el propio padrón del panel.';

-- ---------------------------------------------------------------------------
-- Semilla: la cuenta municipal que ya existe queda habilitada como admin.
--
-- Se busca por correo para no tener que pegar el uuid a mano. Si la cuenta no
-- existe, no pasa nada y la fila se agrega desde el panel más adelante.
--
-- La otra cuenta que hay en Auth (una dirección de Gmail, creada en febrero,
-- anterior a este proyecto) NO se habilita a propósito: si corresponde que
-- tenga acceso, se agrega explícitamente y queda registrado quién lo decidió.
-- ---------------------------------------------------------------------------
insert into public.personal_panel (usuario_id, correo, nombre, rol, notas)
select u.id,
       u.email,
       'Dirección de IA',
       'admin',
       'Semilla de la migración 017. Cuenta institucional preexistente.'
  from auth.users u
 where lower(u.email) = 'direccionia@smt.gob.ar'
on conflict (usuario_id) do nothing;

-- ---------------------------------------------------------------------------
-- El padrón se lee a sí mismo, y sólo lo modifica un admin
-- ---------------------------------------------------------------------------
drop policy if exists personal_se_ve on public.personal_panel;
create policy personal_se_ve on public.personal_panel
  for select to authenticated
  using (usuario_id = auth.uid() or public.es_admin_panel());

drop policy if exists personal_lo_gestiona_un_admin on public.personal_panel;
create policy personal_lo_gestiona_un_admin on public.personal_panel
  for all to authenticated
  using (public.es_admin_panel())
  with check (public.es_admin_panel());

-- ---------------------------------------------------------------------------
-- Datos de vecinos: lectura y actualización SÓLO para personal habilitado
--
-- Sin borrado, igual que antes: son el respaldo documental de un reclamo. Un
-- pedido de supresión se ejecuta con service_role y queda asentado.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['conversaciones','mensajes','sin_respuesta','tickets','program_requests']
  loop
    execute format('drop policy if exists panel_lee on public.%I', t);
    execute format('drop policy if exists panel_actualiza on public.%I', t);
    execute format(
      'create policy panel_lee on public.%I for select to authenticated
         using (public.es_personal_panel())', t);
    execute format(
      'create policy panel_actualiza on public.%I for update to authenticated
         using (public.es_personal_panel()) with check (public.es_personal_panel())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Contenido administrable: mismo criterio
--
-- Esto no es menos grave que los datos personales, y conviene decirlo: con
-- acceso de escritura a `textos_bot` se cambia lo que el bot del municipio le
-- responde a un vecino, y con acceso a `configuracion` se cambia el modelo, el
-- plazo que se comunica y los umbrales. Es suplantación de la voz oficial.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'configuracion','textos_bot','documentos','faqs','respuestas_fijas',
    'limites_volumen','reglas_exclusion','puntos_verdes','zonas_recoleccion',
    'trabajos'
  ]
  loop
    execute format('drop policy if exists panel_gestiona on public.%I', t);
    execute format(
      'create policy panel_gestiona on public.%I for all to authenticated
         using (public.es_personal_panel()) with check (public.es_personal_panel())', t);
  end loop;
end $$;

drop policy if exists panel_lee_fragmentos on public.fragmentos;
create policy panel_lee_fragmentos on public.fragmentos
  for select to authenticated using (public.es_personal_panel());

-- ---------------------------------------------------------------------------
-- Se cierran las funciones que estaban abiertas a cualquiera
--
-- `create function` otorga EXECUTE a PUBLIC por defecto, y en Supabase los
-- roles `anon` y `authenticated` heredan ese PUBLIC. Sumado a que PostgREST
-- publica todo el esquema `public` como RPC, cada una de estas funciones era un
-- endpoint abierto — y al ser `security definer`, un endpoint que además pasaba
-- por encima del RLS que acabamos de ajustar.
--
-- Se revisó quién llama a cada una: las cuatro se invocan únicamente desde
-- `@migue/dominio`, o sea desde el bot y el worker, que usan `service_role`. El
-- panel no llama a ninguna. Así que `authenticated` no necesita ni una, y el
-- permiso queda sólo para `service_role`.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef                      -- sólo las security definer
       and p.proname <> 'es_personal_panel' -- éstas se tratan aparte, abajo
       and p.proname <> 'es_admin_panel'
  loop
    execute format('revoke all on function %s from public, anon', r.firma);
    execute format('grant execute on function %s to service_role', r.firma);
  end loop;
end $$;

-- Los predicados de las políticas los evalúa Postgres al aplicar RLS, así que
-- necesitan EXECUTE para los roles que consultan. No filtran nada por sí solos:
-- devuelven un booleano sobre quien pregunta.
grant execute on function public.es_personal_panel() to authenticated, anon;
grant execute on function public.es_admin_panel()    to authenticated, anon;

-- ---------------------------------------------------------------------------
-- La vista de auditoría, ahora mirando lo que importa
--
-- La versión anterior contaba políticas. Contar no sirve: las diez tablas de
-- contenido tenían una política cada una y esa política era `using (true)`. La
-- vista decía «1 política» y todo parecía en orden.
--
-- Ésta muestra el predicado y marca las políticas permisivas. Sigue valiendo la
-- regla del proyecto: si devuelve filas con `alerta`, hay un problema.
-- ---------------------------------------------------------------------------
drop view if exists public.v_auditoria_rls;
create view public.v_auditoria_rls as
  select c.relname                                    as tabla,
         c.relrowsecurity                             as rls_activo,
         p.policyname                                 as politica,
         p.cmd                                        as operacion,
         array_to_string(p.roles, ',')                as roles,
         coalesce(p.qual, '(sin condicion)')          as condicion_lectura,
         coalesce(p.with_check, '(sin condicion)')    as condicion_escritura,
         case
           when not c.relrowsecurity then 'RLS APAGADO'
           when p.policyname is null  then 'sin politicas: nadie accede (falla cerrada, ok)'
           when 'anon' = any(p.roles) then 'ALCANZA A anon'
           when p.qual = 'true' or p.with_check = 'true' then 'PERMISIVA: using(true)'
           else null
         end                                          as alerta
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
   where n.nspname = 'public'
     and c.relkind = 'r'
   order by (case when not c.relrowsecurity then 0
                  when p.qual = 'true' or p.with_check = 'true' then 1
                  else 2 end),
            c.relname, p.policyname;

comment on view public.v_auditoria_rls is
  'Auditoria de RLS. Muestra el PREDICADO de cada politica, no solo cuantas hay. Toda fila con alerta no nula es un problema.';
