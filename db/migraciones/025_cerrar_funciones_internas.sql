-- ===========================================================================
-- 025 · Cerrar las funciones internas que quedaron abiertas a la clave pública
-- ===========================================================================
-- La 024 puso el detector; ésta actúa sobre lo que encontró. El orden fue a
-- propósito: un revoke masivo a ciegas tendría que repetir de memoria las
-- exclusiones que la 017 hizo con cuidado, y equivocarse ahí deja a todo el mundo
-- afuera del panel.
--
-- QUÉ ENCONTRÓ. Once funciones de `public` con EXECUTE para PUBLIC y para `anon`,
-- o sea ejecutables por cualquiera que tenga la clave pública — que está en el
-- JavaScript del panel y la lee cualquiera. Se ven en el ACL como `=X/postgres`
-- (el destinatario vacío es PUBLIC) y `anon=X/postgres`.
--
-- Ninguna es SECURITY DEFINER, así que corren como quien las llama y el RLS se
-- les aplica: hoy `anon` no puede escribir en ninguna tabla del esquema, y eso ya
-- está probado en el bloque J del arnés. Pero eso es contención INDIRECTA. Si
-- mañana alguien agrega una política permisiva de más, estas funciones son la
-- palanca — y una de ellas, `reemplazar_fragmentos`, hace un delete+insert
-- atómico de todo el corpus de un documento.
--
-- LAS DOS QUE NO SE TOCAN, y por qué:
--
--   es_personal_panel()  las evalúa Postgres al aplicar RLS, así que necesitan
--   es_admin_panel()     EXECUTE para todo rol que consulte una tabla protegida,
--                        `anon` incluido. La 017 las excluyó explícitamente de su
--                        revoke y dejó escrito el motivo. Quitárselas rompe el
--                        panel entero.
--
--   public.keepalive()   TAMPOCO se toca, y es una decisión distinta: no está en
--                        este repo. Su cuerpo es `return api.keepalive()`, o sea
--                        un envoltorio para exponer por REST una función del
--                        esquema `api`, que PostgREST no publica. No sabemos qué
--                        la llama. Si es un scheduler externo usando la clave
--                        pública —el truco habitual para que un proyecto del plan
--                        free no se pause por inactividad— revocarle `anon` la
--                        rompe en silencio y el proyecto se pausa. Se deja
--                        registrada como excepción hasta saber quién la llama.
--
-- CÓMO SE VERIFICÓ QUE ESTO NO ROMPE NADA:
--
--   · Las ocho las llama el bot o el worker con `service_role`, que conserva
--     EXECUTE. Verificado por grep: `encolar_reindexado` y
--     `reemplazar_fragmentos` desde `puertos.ts`; `tomar_trabajo`,
--     `terminar_trabajo` y `recuperar_trabajos_colgados` desde `cola.ts`.
--   · El panel llama a SIETE RPC y ninguna está en esta lista: son
--     `probar_conocimiento`, `probar_disparadores`, `personal_nombres`,
--     `transcripcion`, `resolver_con_faq`, `resolver_con_fija` y
--     `descartar_sin_respuesta`.
--   · Las tres de trigger —`tocar_actualizado_en`, `tocar_updated_at`,
--     `registrar_actividad_conversacion`— siguen funcionando sin EXECUTE.
--     Postgres verifica ese privilegio al CREAR el trigger, no al dispararlo.
--     Probado: se revocó EXECUTE a todos y un UPDATE siguió actualizando
--     `actualizado_en`.
-- ===========================================================================

do $$
declare
  r record;
  -- Explícita y no un `where` genérico: cada nombre acá es una decisión que
  -- alguien tomó mirando quién la llama. Una lista generada sobre la marcha
  -- volvería a barrer las dos que las políticas necesitan.
  internas text[] := array[
    'encolar_reindexado',
    'recuperar_trabajos_colgados',
    'reemplazar_fragmentos',
    'registrar_actividad_conversacion',
    'terminar_trabajo',
    'tomar_trabajo',
    'tocar_actualizado_en',
    'tocar_updated_at'
  ];
  cerradas int := 0;
begin
  for r in
    select p.oid::regprocedure as firma, p.proname as nombre
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any (internas)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.firma);
    execute format('grant execute on function %s to service_role', r.firma);
    cerradas := cerradas + 1;
  end loop;

  raise notice '025: % funcion(es) interna(s) cerradas a la clave publica', cerradas;

  -- Si alguna de la lista no existe, es que se renombró o se borró y la lista
  -- quedó vieja. No se falla —la migración tiene que poder correr sobre
  -- cualquier estado— pero se avisa, porque una lista de seguridad
  -- desactualizada es peor que no tenerla.
  for r in
    select unnest(internas) as nombre
    except
    select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    raise notice '025: OJO, «%» esta en la lista y no existe en la base', r.nombre;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Y las que sí tienen que quedar abiertas, reafirmadas
-- ---------------------------------------------------------------------------
-- No es redundante: deja el estado explícito en el esquema, así que si alguien
-- corre un revoke masivo más adelante, esta migración lo vuelve a poner al
-- reaplicarse. Y hace visible en el repo cuáles son las dos excepciones.
grant execute on function public.es_personal_panel() to authenticated, anon;
grant execute on function public.es_admin_panel()    to authenticated, anon;

comment on function public.es_personal_panel() is
  'Predicado de las politicas de RLS. Necesita EXECUTE para authenticated Y anon: Postgres lo evalua al aplicar RLS sobre cualquier consulta. Quitarselo rompe el panel entero. NO revocar.';
comment on function public.es_admin_panel() is
  'Predicado de las politicas de RLS, incluye supervisor. Necesita EXECUTE para authenticated Y anon por el mismo motivo que es_personal_panel(). NO revocar.';
