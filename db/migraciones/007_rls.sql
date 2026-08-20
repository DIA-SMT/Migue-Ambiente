-- ===========================================================================
-- 007 · Row Level Security — denegación por defecto en TODAS las tablas
-- ===========================================================================
-- Contexto: el relevamiento encontró que con la clave `anon` (pública, va en
-- el JavaScript del navegador) se podían leer nombre, teléfono y dirección de
-- vecinos reales. Esta migración fija la política del proyecto para que no
-- vuelva a pasar.
--
-- Modelo de acceso:
--   anon           -> NADA. Ni una tabla. Sin políticas = sin acceso.
--   authenticated  -> personal del municipio logueado en el panel.
--   service_role   -> bot y worker. Pasa por encima de RLS por diseño de
--                     Supabase; NO necesita políticas y su clave nunca sale
--                     del servidor.
--
-- Regla para el futuro: toda tabla nueva se crea con RLS activo. Si una tabla
-- aparece sin políticas, el efecto es que nadie la lee — falla cerrada, que es
-- la dirección correcta para fallar.
-- ===========================================================================

alter table public.configuracion      enable row level security;
alter table public.textos_bot         enable row level security;
alter table public.documentos         enable row level security;
alter table public.fragmentos         enable row level security;
alter table public.faqs               enable row level security;
alter table public.respuestas_fijas   enable row level security;
alter table public.limites_volumen    enable row level security;
alter table public.reglas_exclusion   enable row level security;
alter table public.puntos_verdes      enable row level security;
alter table public.zonas_recoleccion  enable row level security;
alter table public.conversaciones     enable row level security;
alter table public.mensajes           enable row level security;
alter table public.sin_respuesta      enable row level security;
alter table public.trabajos           enable row level security;
alter table public.tickets            enable row level security;
alter table public.program_requests   enable row level security;

-- ---------------------------------------------------------------------------
-- Contenido administrable: el personal del panel lo gestiona por completo.
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
      'create policy panel_gestiona on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Los fragmentos los genera el worker; el panel sólo necesita verlos para
-- mostrar qué quedó indexado de cada documento.
drop policy if exists panel_lee_fragmentos on public.fragmentos;
create policy panel_lee_fragmentos on public.fragmentos
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Datos personales de vecinos: lectura y actualización de estado, SIN borrado.
--
-- El borrado queda fuera a propósito: son el respaldo documental de un reclamo
-- municipal. Si hay que borrar algo (pedido de supresión de datos), se hace
-- con service_role y queda registrado, no por un clic en el panel.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['conversaciones','mensajes','sin_respuesta','tickets','program_requests']
  loop
    execute format('drop policy if exists panel_lee on public.%I', t);
    execute format('drop policy if exists panel_actualiza on public.%I', t);
    execute format('drop policy if exists panel_lee_tickets on public.%I', t);
    execute format('drop policy if exists panel_lee_programas on public.%I', t);
    execute format('create policy panel_lee on public.%I for select to authenticated using (true)', t);
    execute format('create policy panel_actualiza on public.%I for update to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Verificación: lista todas las tablas de public con su estado de RLS y su
-- cantidad de políticas. Cualquier fila con rls_activo = false es un problema.
-- ---------------------------------------------------------------------------
create or replace view public.v_auditoria_rls as
  select c.relname                                   as tabla,
         c.relrowsecurity                            as rls_activo,
         count(p.policyname)                         as politicas,
         coalesce(array_agg(distinct r.rolname order by r.rolname)
                  filter (where r.rolname is not null), '{}') as roles_con_acceso
    from pg_class c
    left join pg_policies p
           on p.schemaname = 'public' and p.tablename = c.relname
    left join lateral (
           select unnest(p.roles::text[]) as rolname
         ) r on true
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'r'
   group by c.relname, c.relrowsecurity
   order by c.relrowsecurity, c.relname;

comment on view public.v_auditoria_rls is
  'Auditoría de RLS. Toda tabla debe tener rls_activo=true y ningún rol anon.';
