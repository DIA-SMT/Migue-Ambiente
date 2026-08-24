-- ===========================================================================
-- 018 · Lo que el panel necesita y la 017 no le dejó
-- ===========================================================================
-- La 017 cerró un agujero real —«estar logueado» daba acceso a todo— pero cerró
-- de más para el panel. Esta migración abre lo justo, siempre detrás del padrón
-- `personal_panel`, y agrega dos cosas que faltaban desde antes.
--
-- Los tres problemas, VERIFICADOS contra el proyecto en vivo y no deducidos:
--
--   1. El panel no puede subir un documento. No hay ni una política de RLS
--      sobre `storage.objects` en todo db/: el bucket lo creó un script con la
--      service_role, que pasa por encima de RLS. Con la clave anónima que usa
--      el panel, subir devuelve:
--        403  "new row violates row-level security policy"
--
--   2. El panel no puede probar una FAQ antes de publicarla. La 017 revocó
--      EXECUTE de `buscar_conocimiento` a todo lo que no fuera service_role.
--      Con la clave anónima:
--        42501  "permission denied for function buscar_conocimiento"
--
--   3. La migración 015 nunca se aplicó en producción. Sus dos claves de
--      configuración no existen como fila, así que `ia/router.ts` y
--      `nucleo/orquestador.ts` leen valores que nadie puede cambiar desde el
--      panel: se caen al default que está escrito en el código.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · Storage: el bucket «documentos»
--
-- Cuatro operaciones y una ausencia deliberada:
--   select  el panel lista y descarga el original de un documento
--   insert  sube uno nuevo
--   update  hace falta para que `upsert: true` funcione; sin update, reintentar
--           una subida que quedó a medias falla
--   delete  NO. El borrado pasa por la cola de trabajos, que lo hace el worker
--           con service_role: borra el archivo y la fila en un solo camino y
--           deja registro. Un delete directo desde el panel podría dejar la
--           fila apuntando a un archivo que ya no existe.
--
-- Todas exigen `es_personal_panel()`. Y todas se acotan al bucket
-- «documentos»: si mañana hay un bucket para las fotos de vecinos, sus
-- políticas se escriben aparte y a propósito, no se heredan de acá.
-- ---------------------------------------------------------------------------
do $$
declare v_op text;
begin
  -- Si no existe el esquema `storage` no estamos en Supabase (por ejemplo, la
  -- base desechable de las pruebas trae un stub). Se avisa y se sigue: el resto
  -- de la migración no depende de esto.
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'sin esquema storage: se saltean las politicas del bucket';
    return;
  end if;

  -- Envuelto en un manejador a propósito. Crear políticas sobre
  -- `storage.objects` requiere ser dueño de esa tabla, y según cómo esté
  -- configurado el proyecto el rol del editor SQL de Supabase puede no serlo.
  -- Sin este `exception`, ese error aborta el archivo completo y no se aplica
  -- NADA del resto de la migración — que no depende de esto en absoluto.
  -- Pasó de verdad: la 018 se pegó y quedó sin aplicar por entero.
  begin
    foreach v_op in array array['select','insert','update']
    loop
      execute format('drop policy if exists %I on storage.objects',
                     'panel_documentos_' || v_op);
    end loop;

    create policy panel_documentos_select on storage.objects
      for select to authenticated
      using (bucket_id = 'documentos' and public.es_personal_panel());

    create policy panel_documentos_insert on storage.objects
      for insert to authenticated
      with check (bucket_id = 'documentos' and public.es_personal_panel());

    create policy panel_documentos_update on storage.objects
      for update to authenticated
      using (bucket_id = 'documentos' and public.es_personal_panel())
      with check (bucket_id = 'documentos' and public.es_personal_panel());

    raise notice 'politicas del bucket documentos: creadas';
  exception when insufficient_privilege or others then
    raise warning 'NO pude crear las politicas del bucket documentos: %', sqlerrm;
    raise warning 'Hay que crearlas desde el panel de Supabase: Storage -> Policies';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2 · Probar el conocimiento desde el panel
--
-- No se le devuelve EXECUTE de `buscar_conocimiento` a `authenticated`: esa
-- función es SECURITY DEFINER y pasa por encima de RLS, así que dársela a un
-- rol entero sería confiar en que nadie más consiga una sesión. En su lugar, un
-- envoltorio que verifica el padrón ADENTRO y recién entonces delega.
--
-- Es la diferencia entre «el permiso lo da el GRANT» y «el permiso lo verifica
-- la función». Con la segunda, un cambio futuro en los roles no abre nada.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'probar_conocimiento'
  loop
    execute format('drop function if exists %s cascade', r.firma);
  end loop;
end $$;

create function public.probar_conocimiento(
  p_consulta  text,
  p_terminos  text default null,
  p_limite    int  default 8
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
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.es_personal_panel() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  -- Se delega en la función que usa el bot, sin copiarla. Si se duplicara la
  -- lógica, el panel probaría una cosa y el vecino recibiría otra, que es
  -- exactamente lo que una prueba tiene que evitar.
  return query
    select * from public.buscar_conocimiento(p_consulta, p_terminos, p_limite);
end $$;

revoke all on function public.probar_conocimiento(text, text, int) from public, anon;
grant execute on function public.probar_conocimiento(text, text, int) to authenticated, service_role;

comment on function public.probar_conocimiento(text, text, int) is
  'Igual que buscar_conocimiento pero para el panel: verifica el padron adentro en vez de confiar en el GRANT.';

-- ---------------------------------------------------------------------------
-- 3 · Las claves de configuración que el código lee
--
-- Se reinsertan las dos de la 015 porque en producción no están: esa migración
-- nunca se aplicó. Con `on conflict do nothing` esto es inofensivo donde ya
-- existan.
--
-- No es duplicar la 015: es reconciliar. El modo de falla que arregla es
-- silencioso y por eso peligroso — `leerConfig(catalogo, clave, default)`
-- devuelve el default cuando la fila no está, así que el bot funciona y nadie
-- se entera de que hay un parámetro que el panel no puede tocar.
-- ---------------------------------------------------------------------------
insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('umbral_confianza_router', '0.6'::jsonb,
   'Confianza mínima para arrancar un flujo transaccional. Por debajo, el bot intenta responder la consulta en vez de imponer un cuestionario. Más alto que umbral_confianza porque equivocarse de flujo es más molesto para el vecino que no responder.',
   'ia'),
  ('exclusiones_durante_flujo', 'true'::jsonb,
   'Si las reglas de exclusión pueden interrumpir un flujo en curso. Verdadero por defecto: un olor a gas no puede esperar a que el vecino termine de cargar un pedido de escombros.',
   'negocio')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- 4 · El panel necesita resolver un uuid a un nombre
--
-- `personal_se_ve` de la 017 deja que un operador vea sólo su propia fila. Pero
-- el panel muestra «lo cargó X» y «lo resolvió Y» en documentos, FAQs y
-- tickets, y para eso hace falta resolver un uuid a un nombre.
--
-- La primera versión de esta migración lo resolvía con una vista
-- `security_invoker` más una política que dejara leer todas las filas activas.
-- Estaba MAL y vale dejarlo escrito: RLS es por FILA, no por columna. Abrir la
-- fila para que la vista pueda mostrar el nombre abre también el `correo`, que
-- es exactamente lo que la vista pretendía ocultar. Una vista no puede tapar
-- una columna si el que consulta puede leer la tabla.
--
-- Se resuelve con una función que verifica el padrón adentro y devuelve sólo
-- las columnas que el panel necesita. Mismo patrón que `probar_conocimiento`:
-- el permiso lo verifica la función, no el GRANT.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'personal_nombres'
  loop
    execute format('drop function if exists %s cascade', r.firma);
  end loop;
end $$;

create function public.personal_nombres()
returns table (usuario_id uuid, nombre text, rol text)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.es_personal_panel() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  -- Sin `correo` a propósito: para mostrar «lo resolvió M. Lujan» alcanza el
  -- nombre. La lista de direcciones del personal municipal no hace falta.
  return query
    select p.usuario_id, p.nombre, p.rol
      from public.personal_panel p
     where p.activo;
end $$;

revoke all on function public.personal_nombres() from public, anon;
grant execute on function public.personal_nombres() to authenticated, service_role;

comment on function public.personal_nombres() is
  'uuid -> nombre y rol del personal activo, sin el correo. Verifica el padron adentro.';

-- ---------------------------------------------------------------------------
-- 5 · Storage: el bucket «media» (fotos de vecinos)
--
-- Separado del de documentos y con menos permisos, porque es otra cosa: los
-- documentos son información pública que el bot cita, las fotos son de la
-- propiedad de un vecino.
--
--   select  el panel muestra la foto adjunta al abrir un caso. Con URL firmada,
--           porque el bucket es privado.
--   insert  NO para `authenticated`. Las fotos las sube el WORKER con
--           service_role, bajándolas del canal. El panel no sube fotos de
--           vecinos: no tiene de dónde.
--   delete  NO. El borrado, cuando haya política de retención, lo hará un
--           proceso con service_role y por lote.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'sin esquema storage: se saltea la politica del bucket media';
    return;
  end if;

  begin
    drop policy if exists panel_media_select on storage.objects;
    create policy panel_media_select on storage.objects
      for select to authenticated
      using (bucket_id = 'media' and public.es_personal_panel());
    raise notice 'politica del bucket media: creada';
  exception when insufficient_privilege or others then
    raise warning 'NO pude crear la politica del bucket media: %', sqlerrm;
  end;
end $$;

-- `photo_url` guarda la RUTA en el bucket, no una URL pública.
--
-- La 012 la había documentado como «URL pública en Supabase Storage», que
-- suponía un bucket público. Un bucket público es una URL que se puede
-- enumerar, y acá hay fotos de la propiedad de vecinos: el bucket es privado y
-- el panel pide una URL firmada cuando tiene que mostrarla. Se corrige el
-- comentario para que la próxima persona no lo interprete al revés.
comment on column public.tickets.photo_url is
  'Ruta del archivo DENTRO del bucket privado «media». No es una URL publica: el panel pide una URL firmada. Null mientras el worker no la haya bajado del canal.';
comment on column public.program_requests.photo_url is
  'Ruta del archivo DENTRO del bucket privado «media». No es una URL publica: el panel pide una URL firmada. Null mientras el worker no la haya bajado del canal.';
