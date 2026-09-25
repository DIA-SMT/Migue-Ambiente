-- ===========================================================================
-- 037 · Veredicto de foto y pedido de asesor
-- ===========================================================================
-- Dos capacidades nuevas del bot que el panel tiene que poder ver:
--
--   1. El bot ahora MIRA la foto del retiro y del reclamo con un modelo de
--      visión (`modelo_vision`) y deja el veredicto en el ticket. El panel lo
--      muestra junto a la foto y marca en la bandeja los casos donde la foto
--      no acompaña lo declarado. Si la foto claramente no corresponde, el bot
--      repregunta UNA vez; nunca bloquea el trámite, y cuando no puede evaluar
--      lo dice (`no_evaluada`) en lugar de mentir «valida».
--
--   2. El vecino puede pedir hablar con una persona. Hasta hoy ese pedido caía
--      al azar: «no tengo esa información», el menú, o —peor— derivado a Migue,
--      el bot general. Ahora genera una fila en `alertas_asesor` y el panel la
--      muestra hasta que alguien la atiende. No se le pide teléfono: la
--      respuesta le llega por el mismo chat, y cuando el bot migre a WhatsApp
--      el número va a venir solo con el mensaje.
--
-- Sin Realtime, a propósito: el proyecto ya decidió en worker/bucle.ts que un
-- websocket permanente es un modo de falla nuevo; el panel consulta cada
-- tanto, que para responder un pedido alcanza y sobra.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · El veredicto de la foto, en el ticket
--
-- En inglés como toda columna de `tickets` (regla de la 001: cada tabla es
-- internamente coherente con su idioma). Los VALORES en castellano: son datos
-- que el panel muestra, igual que `status`.
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists photo_verdict  text,
  add column if not exists photo_category text,
  add column if not exists photo_detail   text;

-- Drop-first para poder ajustar la lista sin una migración de renombre.
-- NULL pasa cualquier CHECK, así que las filas viejas no necesitan `not valid`.
alter table public.tickets drop constraint if exists tickets_photo_verdict_valido;
alter table public.tickets
  add constraint tickets_photo_verdict_valido
    check (photo_verdict in ('valida','dudosa','no_corresponde','no_evaluada'));

alter table public.tickets drop constraint if exists tickets_photo_category_valida;
alter table public.tickets
  add constraint tickets_photo_category_valida
    check (photo_category in ('basural','volcadero','rnh','barrido','limpieza_cestos','otros'));

comment on column public.tickets.photo_verdict is
  'Lo escribe el BOT con service_role al mirar la foto con modelo_vision. '
  'valida = se ve lo que el vecino declaró. dudosa = no se puede confirmar. '
  'no_corresponde = la foto muestra otra cosa (el bot repreguntó una vez). '
  'no_evaluada = el bot intentó y no pudo (falló el proveedor o la visión está '
  'apagada). NULL = ticket sin foto o anterior a la 037. El panel NO lo edita: '
  'es la opinión del modelo, y corregirla a mano sería falsificar la evidencia.';

comment on column public.tickets.photo_category is
  'Qué vio el modelo en la foto (taxonomía del área: basural, volcadero, rnh, '
  'barrido, limpieza_cestos, otros). Lo escribe el bot con service_role.';

comment on column public.tickets.photo_detail is
  'Explicación corta del modelo, en castellano. Es lo que se interpola en '
  '{detalle} cuando el bot repregunta por la foto.';

-- ---------------------------------------------------------------------------
-- 2 · Pedidos de asesor
--
-- El teléfono queda como columna para el futuro WhatsApp (ahí el número viene
-- con el mensaje). En Telegram va null: decidimos no pedírselo al vecino.
-- La tabla contiene únicamente lo necesario para responder el pedido, y la
-- lee sólo el padrón, por RLS.
-- ---------------------------------------------------------------------------
create table if not exists public.alertas_asesor (
  id              uuid primary key default gen_random_uuid(),
  conversacion_id uuid references public.conversaciones(id) on delete set null,
  canal           text not null check (canal in ('telegram','whatsapp','web')),
  nombre_usuario  text,
  telefono        text,
  motivo          text,
  estado          text not null default 'pendiente'
                    check (estado in ('pendiente','atendida','descartada')),
  -- uuid SIN foreign key, como revisada_por (004) y creada_por (002): el
  -- nombre se resuelve con personal_nombres() y la fila no debe depender de
  -- que la cuenta siga existiendo en auth.users.
  atendida_por    uuid,
  atendida_en     timestamptz,
  notas           text,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

comment on table public.alertas_asesor is
  'Vecinos que pidieron hablar con una persona. Inserta el BOT con '
  'service_role; el panel las lee y las cierra vía atender_alerta().';

comment on column public.alertas_asesor.telefono is
  'Teléfono de contacto. En Telegram es null (el canal no lo da y no se pide); '
  'en WhatsApp va a venir con el mensaje. Sólo lo lee el padrón (RLS).';
comment on column public.alertas_asesor.motivo is
  'El mensaje del vecino que disparó el pedido, para dar contexto al responder.';

-- Sirve al badge (count de pendientes) y a la lista de trabajo.
create index if not exists alertas_asesor_pendientes_idx
  on public.alertas_asesor (creado_en desc) where estado = 'pendiente';

drop trigger if exists alertas_asesor_tocar on public.alertas_asesor;
create trigger alertas_asesor_tocar before update on public.alertas_asesor
  for each row execute function public.tocar_actualizado_en();

alter table public.alertas_asesor enable row level security;

-- Sólo LECTURA directa. La escritura va por atender_alerta(): una política de
-- UPDATE dejaría editar telefono y motivo —reescribir lo que dijo el vecino—
-- y no puede garantizar el invariante atendida_por/atendida_en.
drop policy if exists panel_lee on public.alertas_asesor;
create policy panel_lee on public.alertas_asesor
  for select to authenticated
  using (public.es_personal_panel());
-- SIN insert (inserta el bot con service_role, que saltea RLS) y SIN delete:
-- descartar es un estado, no un borrado.

-- ---------------------------------------------------------------------------
-- 3 · Cerrar una alerta, con quién y cuándo sellados adentro
--     (patrón de la 021: drop por firma + definer + guardia + revoke)
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'atender_alerta'
  loop
    execute format('drop function if exists %s cascade', r.firma);
  end loop;
end $$;

create function public.atender_alerta(
  p_alerta_id uuid,
  p_estado    text,
  p_notas     text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.es_personal_panel() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;
  if p_estado not in ('pendiente','atendida','descartada') then
    raise exception 'estado invalido: %', p_estado;
  end if;

  update public.alertas_asesor
     set estado       = p_estado,
         -- Reabrir limpia el sello; cerrar lo pone. Nunca lo elige el cliente.
         atendida_por = case when p_estado = 'pendiente' then null else auth.uid() end,
         atendida_en  = case when p_estado = 'pendiente' then null else now() end,
         notas        = coalesce(nullif(trim(coalesce(p_notas, '')), ''), notas)
   where id = p_alerta_id;

  if not found then raise exception 'no existe esa alerta'; end if;
end $$;

revoke all on function public.atender_alerta(uuid, text, text) from public, anon;
grant execute on function public.atender_alerta(uuid, text, text) to authenticated;

comment on function public.atender_alerta(uuid, text, text) is
  'Cierra o reabre una alerta de asesor. Sella atendida_por/atendida_en con '
  'auth.uid() y now(): dejárselo al cliente garantiza alertas atendidas sin '
  'fecha ni responsable.';

-- ---------------------------------------------------------------------------
-- 4 · Configuración y textos nuevos
-- ---------------------------------------------------------------------------
insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('modelo_vision', '"anthropic/claude-haiku-4.5"'::jsonb,
   'Modelo de OpenRouter con visión que mira la foto del retiro y del reclamo '
   'y deja el veredicto en el ticket. Vaciarlo APAGA la evaluación sin deploy: '
   'los tickets quedan con photo_verdict en no_evaluada y el flujo sigue como '
   'antes. Corre sólo cuando llega una foto dentro del paso que la espera.',
   'ia')
on conflict (clave) do nothing;

-- Los textos: la confirmación del pedido de asesor y la repregunta de foto.
-- El pedido de asesor NO pide teléfono. Decisión del área: en Telegram no hay
-- a quién llamar desde afuera igual (el canal no da número), la respuesta le
-- llega al vecino por el mismo chat, y cuando el bot migre a WhatsApp el
-- número va a venir solo con el mensaje.
--
-- El formato de estas tuplas es parseado por catalogo.claves.test.ts: cada una
-- abre su propia línea con ('clave', — no lo cambies (ver 033).
insert into public.textos_bot (clave, texto, descripcion, opcional) values
  ('asesor_confirmacion',
   'Listo, ya le avisé al equipo de Ambiente: una persona va a ver tu pedido y te responden por acá en el horario de atención. Si mientras tanto necesitás otra cosa, escribime.',
   'Confirmación cuando el vecino pide hablar con una persona. La alerta queda en el panel; la respuesta del equipo llega por el mismo chat.',
   false),

  ('retiro_foto_no_corresponde',
   E'Mirá, en la foto no llego a ver residuos: {detalle}.\n\n¿Podés mandar otra donde se vea lo que hay que retirar? Si es la única que tenés, mandámela de nuevo y sigo igual.',
   'Retiro: repregunta única cuando el modelo de visión dice que la foto no corresponde. {detalle} se reemplaza por la explicación del modelo. VACIARLO apaga la repregunta: el bot acepta la foto y sólo marca el ticket.',
   true)
on conflict (clave) do nothing;

-- Limpieza por si se aplicó la versión anterior de ESTA misma migración, que
-- sembraba un flujo de pedir teléfono con tres textos más y una confirmación
-- con {telefono}. Los delete y el update van condicionados al texto EXACTO
-- sembrado: si el área ya escribió algo propio en esas claves, no se toca.
delete from public.textos_bot
 where clave in ('asesor_pedir_telefono', 'asesor_reintento_telefono', 'asesor_sin_telefono')
   and texto in (
     E'Dale, le aviso al equipo de Ambiente para que se contacten con vos.\n\n¿Me dejás un teléfono para que te llamen? Escribilo con característica, por ejemplo 381 5123456. Si preferís no darlo, decime «no» y paso el pedido igual.',
     'No llegué a encontrar un teléfono en tu mensaje. ¿Me lo escribís con característica? Por ejemplo: 381 5123456. Si preferís no darlo, decime «no» y paso el pedido igual.',
     'Listo, ya avisé al equipo igual. Como no tengo un teléfono tuyo, la respuesta te va a llegar por acá. Si mientras tanto necesitás otra cosa de Ambiente, escribime.'
   );

update public.textos_bot
   set texto = 'Listo, ya le avisé al equipo de Ambiente: una persona va a ver tu pedido y te responden por acá en el horario de atención. Si mientras tanto necesitás otra cosa, escribime.',
       descripcion = 'Confirmación cuando el vecino pide hablar con una persona. La alerta queda en el panel; la respuesta del equipo llega por el mismo chat.'
 where clave = 'asesor_confirmacion'
   and texto = 'Listo, ya avisé al equipo. Te van a contactar al {telefono} en el horario de atención. Si mientras tanto necesitás otra cosa de Ambiente, escribime.';

-- ---------------------------------------------------------------------------
-- 5 · Mejor pluma, sólo si nadie la eligió ya
--     (condición sobre el valor sembrado, como la 009, la 011 y la 036)
-- ---------------------------------------------------------------------------
update public.configuracion
   set valor = '"anthropic/claude-sonnet-5"'::jsonb,
       descripcion = 'Modelo de OpenRouter para redactar la respuesta final. '
         'claude-sonnet-5 redacta mejor el rioplatense; con el corpus actual '
         'sigue costando centavos por respuesta. Alternativa más barata: '
         'anthropic/claude-haiku-4.5. Verificado contra el catálogo real de '
         'OpenRouter.'
 where clave = 'modelo_respuesta'
   and valor = '"anthropic/claude-haiku-4.5"'::jsonb;

update public.configuracion
   set valor = to_jsonb(
     '- Español rioplatense, voseo. Cordial y directo, como quien atiende bien un mostrador.' || chr(10) ||
     '- Breve: dos o tres frases salvo que la pregunta pida un listado.' || chr(10) ||
     '- Dá el dato primero. Si hace falta aclarar algo, después.' || chr(10) ||
     '- Nada de muletillas de asistente («¡Claro!», «¡Por supuesto!», «¡Excelente pregunta!»): arrancá por la respuesta.' || chr(10) ||
     '- Si la respuesta es un no, decilo sin vueltas y ofrecé la alternativa que haya en el contexto.' || chr(10) ||
     '- No cites números de fragmento ni nombres de archivo: al vecino no le sirven.' || chr(10) ||
     '- Si el contexto tiene direcciones u horarios, transcribilos exactos.')
 where clave = 'estilo_respuesta'
   -- El texto EXACTO que sembró la 032, byte a byte. Si el área ya lo editó
   -- desde el panel, esta migración no le pisa la redacción.
   and valor = to_jsonb('- Español rioplatense, voseo. Tratamiento cordial y directo.' || chr(10) ||
    '- Breve: dos o tres frases salvo que la pregunta pida un listado.' || chr(10) ||
    '- Dá el dato primero. Si hace falta aclarar algo, después.' || chr(10) ||
    '- No cites números de fragmento ni nombres de archivo: al vecino no le sirven.' || chr(10) ||
    '- Si el contexto tiene direcciones u horarios, transcribilos exactos.');
