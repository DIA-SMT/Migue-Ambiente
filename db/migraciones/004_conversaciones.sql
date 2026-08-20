-- ===========================================================================
-- 004 · Conversaciones, mensajes y preguntas sin responder
-- ===========================================================================
-- OJO: estas tablas contienen DATOS PERSONALES de vecinos (nombre, teléfono,
-- dirección, fotos). La migración 007 les aplica RLS con denegación por
-- defecto. Ninguna de estas tablas debe quedar legible por el rol `anon`.
-- ===========================================================================

create table if not exists public.conversaciones (
  id                uuid primary key default gen_random_uuid(),
  canal             text not null check (canal in ('telegram','whatsapp','web')),
  -- Identificador del usuario EN ESE CANAL (chat id de Telegram, teléfono en
  -- WhatsApp). La unicidad es por canal: la misma persona en dos canales son
  -- dos conversaciones distintas, y está bien que lo sean.
  canal_usuario_id  text not null,
  nombre_usuario    text,
  telefono          text,
  flujo_activo      text,
  paso_actual       text,
  estado            text not null default 'abierta'
                      check (estado in ('abierta','cerrada','derivada','abandonada')),
  cantidad_mensajes int  not null default 0,
  iniciada_en       timestamptz not null default now(),
  ultima_actividad_en timestamptz not null default now(),
  cerrada_en        timestamptz
);

create index if not exists conversaciones_canal_usuario_idx
  on public.conversaciones (canal, canal_usuario_id);
create index if not exists conversaciones_abiertas_idx
  on public.conversaciones (ultima_actividad_en desc) where estado = 'abierta';
create index if not exists conversaciones_recientes_idx
  on public.conversaciones (iniciada_en desc);

comment on column public.conversaciones.flujo_activo is
  'Flujo transaccional en curso (retiro_no_habitual, reclamo_recoleccion, ...). null = charla libre.';

-- ---------------------------------------------------------------------------
-- Mensajes. Es la bitácora que alimenta "revisar consultas" y las métricas.
-- ---------------------------------------------------------------------------
create table if not exists public.mensajes (
  id              uuid primary key default gen_random_uuid(),
  conversacion_id uuid not null references public.conversaciones(id) on delete cascade,
  direccion       text not null check (direccion in ('entrante','saliente')),
  texto           text,
  media_tipo      text check (media_tipo in ('imagen','audio','video','documento','ubicacion')),
  media_ruta      text,

  -- Trazabilidad de la decisión del bot. Sin esto es imposible auditar por qué
  -- contestó lo que contestó, que es justo lo que falló en el bot anterior.
  intencion       text,
  confianza       numeric(4,3) check (confianza is null or (confianza >= 0 and confianza <= 1)),
  origen_respuesta text check (origen_respuesta in
                      ('respuesta_fija','faq','documentos','flujo','exclusion','fallback')),
  fragmentos_citados uuid[],

  -- Costo y latencia por mensaje: permite ver en el panel qué sale caro.
  modelo          text,
  tokens_entrada  int,
  tokens_salida   int,
  costo_usd       numeric(10,6),
  latencia_ms     int,

  creado_en       timestamptz not null default now()
);

create index if not exists mensajes_conversacion_idx
  on public.mensajes (conversacion_id, creado_en);
create index if not exists mensajes_fecha_idx on public.mensajes (creado_en desc);
create index if not exists mensajes_intencion_idx
  on public.mensajes (intencion) where intencion is not null;

-- Mantener el contador y la actividad al día sin que la app tenga que acordarse.
create or replace function public.registrar_actividad_conversacion()
returns trigger language plpgsql as $$
begin
  update public.conversaciones
     set cantidad_mensajes   = cantidad_mensajes + 1,
         ultima_actividad_en = new.creado_en
   where id = new.conversacion_id;
  return new;
end $$;

drop trigger if exists mensajes_actividad on public.mensajes;
create trigger mensajes_actividad after insert on public.mensajes
  for each row execute function public.registrar_actividad_conversacion();

-- ---------------------------------------------------------------------------
-- Preguntas que el bot NO pudo responder.
--
-- Es la tabla más valiosa del sistema: es el circuito de mejora. Cada fila es
-- un vecino que se fue sin respuesta, y el panel permite resolverla creando
-- una FAQ. Al resolverla queda apuntada a qué la resolvió, así se puede medir
-- si el arreglo sirvió.
-- ---------------------------------------------------------------------------
create table if not exists public.sin_respuesta (
  id              uuid primary key default gen_random_uuid(),
  conversacion_id uuid references public.conversaciones(id) on delete set null,
  mensaje_id      uuid references public.mensajes(id) on delete set null,
  pregunta        text not null,
  motivo          text not null default 'sin_coincidencia'
                    check (motivo in ('sin_coincidencia','confianza_baja','fuera_de_alcance','error_modelo')),
  confianza       numeric(4,3),
  veces_repetida  int  not null default 1,
  estado          text not null default 'pendiente'
                    check (estado in ('pendiente','resuelta','descartada')),
  resuelta_con_faq_id uuid references public.faqs(id) on delete set null,
  resuelta_con_fija_id uuid references public.respuestas_fijas(id) on delete set null,
  notas           text,
  revisada_por    uuid,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

drop trigger if exists sin_respuesta_tocar on public.sin_respuesta;
create trigger sin_respuesta_tocar before update on public.sin_respuesta
  for each row execute function public.tocar_actualizado_en();

create index if not exists sin_respuesta_pendientes_idx
  on public.sin_respuesta (creado_en desc) where estado = 'pendiente';
create index if not exists sin_respuesta_pregunta_trigram_idx
  on public.sin_respuesta using gin (pregunta gin_trgm_ops);

comment on column public.sin_respuesta.veces_repetida is
  'Se agrupan preguntas parecidas por similitud trigram: prioriza lo que más se pregunta.';
