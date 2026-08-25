-- ===========================================================================
-- 027 · La pantalla Personal
-- ===========================================================================
-- `personal_panel` es el padrón que la 017 creó para cerrar un agujero real:
-- cualquiera podía registrarse en Supabase y leer datos de vecinos. Desde
-- entonces, estar en `auth.users` no alcanza — hay que estar acá.
--
-- Administrarlo se venía haciendo a mano por SQL. Esta migración le da al panel
-- lo que le falta para hacerlo, y cierra un modo de falla que no tiene arreglo
-- desde el panel mismo.
--
-- LO QUE ESTA PANTALLA NO VA A PODER HACER, y es a propósito: crear cuentas. Eso
-- se hace en Supabase (Authentication → Users → Add user, con Auto Confirm) y el
-- registro público está deshabilitado. El panel da de alta en el PADRÓN a alguien
-- que ya tiene cuenta, le cambia el rol, y lo da de baja.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0 · Cerrar un hueco de la 024, que mi propio detector encontró
-- ---------------------------------------------------------------------------
-- La 024 hizo `alter default privileges ... revoke execute on functions from
-- public` para que lo nuevo naciera cerrado. No alcanzaba: Supabase configura sus
-- propios default privileges concediendo EXECUTE a `anon`, `authenticated` y
-- `service_role`, así que revocarle sólo a PUBLIC deja el grant a `anon` — que es
-- la clave que está en el JavaScript del panel.
--
-- Se descubrió sola: el bloque O del arnés falló al agregar el trigger de acá
-- abajo, con «funciones abiertas a la clave publica:
-- nadie_se_bloquea_a_si_mismo». El detector funcionando sobre mi propio código,
-- una migración después de escribirlo.
--
-- Ahora el default se revoca a los tres. Consecuencia: toda función nueva nace
-- sin permisos y hay que concederlos a propósito, que es el criterio de la 017.
-- Las de este archivo lo hacen explícito más abajo.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1 · EL MODO DE FALLA QUE NO TIENE VUELTA
-- ---------------------------------------------------------------------------
-- Verificado en una base desechable con las 26 migraciones aplicadas: el ÚNICO
-- admin puede bajarse el rol a sí mismo, darse de baja y borrarse. Las tres
-- operaciones pasan, y después no puede revertir ninguna porque ya no es admin.
-- El panel queda sin nadie que lo administre y sólo se arregla por SQL.
--
-- POR QUÉ UN TRIGGER Y NO UN `with check` MÁS ESTRICTO. `es_admin_panel()` es
-- STABLE, así que dentro del propio UPDATE ve el snapshot ANTERIOR: el que se
-- está degradando todavía figura como admin cuando se evalúa la política, y el
-- chequeo pasa siempre. La política no puede verlo; el trigger sí.
--
-- LA REGLA: nadie se toca a sí mismo el rol ni el activo, ni se borra la fila.
--
-- Es la formulación más simple y la que cubre todo, y elegirla así tiene una
-- consecuencia buena: quien ejecuta la operación SIEMPRE sobrevive con su rol
-- intacto, así que es estructuralmente imposible que el padrón se quede sin
-- administrador. La alternativa —contar cuántos admins quedan— es un invariante
-- que hay que mantener y que se puede burlar con dos operaciones en paralelo.
--
-- El nombre propio sí se puede editar. Nadie se bloquea corrigiendo su apellido.
create or replace function public.nadie_se_bloquea_a_si_mismo()
returns trigger
language plpgsql
as $$
begin
  -- `auth.uid()` es null cuando la operación viene de `service_role`, o sea del
  -- SQL Editor de Supabase. La comparación da NULL, el `if` no entra, y el
  -- trigger no dispara.
  --
  -- Eso NO es un descuido: es la puerta de salida. Si alguien igual queda
  -- bloqueado —por un borrado de cuenta en Supabase, por ejemplo— el editor
  -- sigue pudiendo arreglarlo. Sin esa puerta, el trigger convertiría un
  -- problema recuperable en uno que necesita soporte de Supabase.
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.usuario_id = auth.uid() then
      raise exception
        'No podés borrarte del padrón a vos mismo. Pedile a otro admin que lo haga, '
        'o dejá de ser admin primero.'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if old.usuario_id = auth.uid() then
    if new.rol <> old.rol then
      raise exception
        'No podés cambiarte el rol a vos mismo: si sos el único admin, el panel queda '
        'sin nadie que lo administre y no se puede arreglar desde acá. Pedile a otro '
        'admin que te lo cambie.'
        using errcode = '42501';
    end if;
    if new.activo <> old.activo then
      raise exception
        'No podés darte de baja a vos mismo. Pedile a otro admin que lo haga.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

comment on function public.nadie_se_bloquea_a_si_mismo() is
  'Impide que alguien se saque a si mismo el rol, el activo, o su fila del padron. Garantiza que quien ejecuta sobrevive, asi que el padron nunca queda sin administrador. Con service_role no dispara: el SQL Editor sigue siendo la puerta de salida.';

-- Una función de trigger no necesita EXECUTE para dispararse: Postgres verifica
-- ese privilegio al CREAR el trigger, no al ejecutarlo. Comprobado en una base
-- desechable —se revocó a todos y un UPDATE siguió actualizando— así que
-- revocarla no rompe nada y saca una entrada de la superficie ejecutable.
revoke all on function public.nadie_se_bloquea_a_si_mismo() from public, anon, authenticated;

drop trigger if exists personal_no_se_autobloquea on public.personal_panel;
create trigger personal_no_se_autobloquea
  before update or delete on public.personal_panel
  for each row execute function public.nadie_se_bloquea_a_si_mismo();

-- ---------------------------------------------------------------------------
-- 2 · Resolver un correo a su cuenta
-- ---------------------------------------------------------------------------
-- Es el punto técnico central de la pantalla, y no se puede evitar: PostgREST
-- expone SÓLO los esquemas `public` y `graphql_public`, así que `auth.users` es
-- inalcanzable por HTTP — con la clave pública y también con la del sistema.
--
-- Una vista no sirve. Con `security_invoker` le pediría al panel permisos sobre
-- `auth.users` que no tiene; sin invoker sería una vista definer, que es
-- exactamente lo que la 018 descartó por escrito cuando una vista sobre el
-- padrón iba a exponer los correos de todos.
--
-- Tres decisiones que conviene que queden acá y no en un comentario suelto:
--
--   a) El guard es `es_admin_panel()` y NO `es_personal_panel()`. Más estricto
--      que `personal_nombres()`, porque acá sí salen correos.
--
--   b) Devuelve SÓLO las cuentas que NO están en el padrón. No es un listado de
--      `auth.users`: así la función no sirve para nada más que para lo que
--      existe, y no se convierte en un endpoint para enumerar usuarios.
--
--   c) NO devuelve nada que permita autenticarse. `auth.users` tiene
--      `encrypted_password`, tokens de recuperación y `raw_app_meta_data`. El
--      próximo que edite esta función va a tener la tentación de agregar campos:
--      que quede escrito que esos tres no salen de acá nunca.
create or replace function public.cuentas_sin_padron()
returns table (
  usuario_id     uuid,
  correo         text,
  creada_en      timestamptz,
  confirmada     boolean,
  ultimo_ingreso timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth, pg_catalog
as $$
begin
  if not public.es_admin_panel() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  return query
    select u.id,
           u.email::text,
           u.created_at,
           u.email_confirmed_at is not null,
           u.last_sign_in_at
      from auth.users u
      left join public.personal_panel p on p.usuario_id = u.id
     where p.usuario_id is null
       and u.deleted_at is null
     order by u.created_at desc;
end $$;

comment on function public.cuentas_sin_padron() is
  'Cuentas de Supabase que NO estan en el padron, para poder darlas de alta. Solo admin. No devuelve nada que permita autenticarse: ni encrypted_password, ni tokens, ni raw_app_meta_data.';

revoke all on function public.cuentas_sin_padron() from public, anon;
grant execute on function public.cuentas_sin_padron() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3 · Cuándo se cambió un rol
-- ---------------------------------------------------------------------------
-- Era la única tabla administrable sin `actualizado_en`, y da la pena de que
-- justo la del control de acceso no pueda decir cuándo se cambió un permiso.
alter table public.personal_panel
  add column if not exists actualizado_en timestamptz not null default now();

drop trigger if exists personal_tocar on public.personal_panel;
create trigger personal_tocar
  before update on public.personal_panel
  for each row execute function public.tocar_actualizado_en();

-- ---------------------------------------------------------------------------
-- 4 · Un correo activo, una sola fila
-- ---------------------------------------------------------------------------
-- Verificado que hoy entran dos filas activas con el mismo correo, y eso hace
-- que la pantalla muestre a la misma persona dos veces con roles distintos —
-- sin forma de saber cuál manda.
--
-- PARCIAL y no total a propósito: el mismo correo puede volver legítimamente con
-- otro `usuario_id` si la cuenta se borró y se recreó en Supabase. Lo que no
-- puede haber son dos ACTIVAS.
create unique index if not exists personal_panel_correo_activo_idx
  on public.personal_panel (lower(correo)) where activo;

-- ---------------------------------------------------------------------------
-- 5 · Lo que hay que saber para no perder el registro
-- ---------------------------------------------------------------------------
-- `usuario_id` es la clave primaria Y una FK a `auth.users` con ON DELETE
-- CASCADE. O sea: borrar una cuenta en Supabase Authentication se lleva también
-- su fila del padrón, y con ella el registro de que esa persona tuvo acceso —
-- que es literalmente para lo que la 017 dice que existe la columna `activo`.
--
-- Cambiarlo a SET NULL es imposible: es la clave primaria.
--
-- La salida es una regla operativa, no un cambio de esquema: en Supabase NO se
-- borran cuentas, se dan de baja acá. La pantalla lo dice. Una tabla de bitácora
-- aparte que sobreviva al cascade sería lo correcto si esto llegara a pasar
-- alguna vez, y todavía no pasó.
comment on column public.personal_panel.usuario_id is
  'FK a auth.users con ON DELETE CASCADE: borrar la cuenta en Supabase borra esta fila y el registro de que tuvo acceso. Regla operativa: en Supabase no se borran cuentas, se dan de baja acá.';

comment on column public.personal_panel.activo is
  'Da y quita el acceso. Una baja NO borra la fila: queda el registro de que esa persona estuvo habilitada, que es lo que hace auditable el control de acceso.';

comment on column public.personal_panel.rol is
  'operador escribe borradores · supervisor tambien publica · admin tambien borra y administra el padron. Los tres pasan es_personal_panel(); supervisor y admin pasan es_admin_panel().';
