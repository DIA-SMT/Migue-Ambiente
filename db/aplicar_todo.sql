-- ===========================================================================
-- MIGUE AMBIENTE · esquema completo
-- Generado por: cat migraciones/*.sql — NO editar este archivo.
-- Editá las migraciones individuales y regenerá con: bash generar_aplicar_todo.sh
--
-- Aplicar: pegar en el SQL Editor de Supabase y ejecutar.
-- Es idempotente: se puede correr varias veces sin romper nada.
-- ===========================================================================


-- >>>>>>>>>>>>>>>>>>>> 001_base.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 001 · Extensiones, utilidades y configuración editable
-- ===========================================================================
-- Convención de nombres: identificadores en español, SIN acentos ni ñ.
-- Excepción documentada: las tablas `tickets` y `program_requests` ya existían
-- (bot anterior en ManyChat) y conservan sus nombres y columnas en inglés; las
-- columnas que les agreguemos siguen ESE idioma para que cada tabla sea
-- internamente coherente. Todo lo nuevo va en español.
-- ===========================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;    -- similitud difusa (errores de tipeo)
create extension if not exists unaccent;   -- "poda" == "podá"

-- Búsqueda de texto en español INSENSIBLE A ACENTOS.
-- Sin esto, un vecino que escribe "reciclaje organico" no encuentra
-- "reciclaje orgánico", que es exactamente cómo escribe la gente en el chat.
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'es_sin_acentos') then
    create text search configuration public.es_sin_acentos (copy = spanish);
    alter text search configuration public.es_sin_acentos
      alter mapping for hword, hword_part, word with unaccent, spanish_stem;
  end if;
end $$;

-- to_tsvector(regconfig, text) es IMMUTABLE, así que sirve en columnas
-- generadas. Ojo: hay que pasar la config explícita; la variante de un solo
-- argumento depende de una GUC y no es inmutable.

create or replace function public.tocar_actualizado_en()
returns trigger language plpgsql as $$
begin
  new.actualizado_en = now();
  return new;
end $$;

comment on function public.tocar_actualizado_en is
  'Trigger BEFORE UPDATE: mantiene actualizado_en al día.';

-- ---------------------------------------------------------------------------
-- Configuración del bot editable desde el panel.
-- Todo lo que un operador podría querer cambiar sin un deploy vive acá.
-- ---------------------------------------------------------------------------
create table if not exists public.configuracion (
  clave         text primary key,
  valor         jsonb       not null,
  descripcion   text        not null,
  categoria     text        not null default 'general',
  actualizado_en timestamptz not null default now(),
  actualizado_por uuid
);

drop trigger if exists configuracion_tocar on public.configuracion;
create trigger configuracion_tocar before update on public.configuracion
  for each row execute function public.tocar_actualizado_en();

comment on table public.configuracion is
  'Parámetros operativos (SLA, modelo de IA, umbrales). Editable desde el panel.';

-- ---------------------------------------------------------------------------
-- Textos del bot. NINGÚN mensaje al vecino se escribe en el código: si está
-- acá, Comunicación lo corrige sin tocar un deploy ni esperar a un dev.
-- ---------------------------------------------------------------------------
create table if not exists public.textos_bot (
  clave         text primary key,
  texto         text        not null,
  descripcion   text        not null,
  canal         text,                    -- null = sirve para todos los canales
  actualizado_en timestamptz not null default now(),
  actualizado_por uuid
);

drop trigger if exists textos_bot_tocar on public.textos_bot;
create trigger textos_bot_tocar before update on public.textos_bot
  for each row execute function public.tocar_actualizado_en();

comment on column public.textos_bot.canal is
  'null = vale para todo canal. Permite redactar distinto en Telegram y WhatsApp.';

-- >>>>>>>>>>>>>>>>>>>> 002_conocimiento.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 002 · Base de conocimiento: documentos, fragmentos, FAQs, respuestas fijas
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Documentos subidos desde el panel (PDF / DOCX)
-- El archivo vive en Supabase Storage; acá va el metadato y el estado de
-- procesamiento, que es lo que el panel muestra mientras el worker trabaja.
-- ---------------------------------------------------------------------------
create table if not exists public.documentos (
  id             uuid primary key default gen_random_uuid(),
  titulo         text        not null,
  descripcion    text,
  nombre_archivo text        not null,
  formato        text        not null check (formato in ('pdf','docx','txt','md')),
  ruta_storage   text        not null unique,
  bytes          bigint      not null check (bytes > 0),
  hash_sha256    text,
  paginas        int,
  estado         text        not null default 'pendiente'
                   check (estado in ('pendiente','procesando','listo','error')),
  error_detalle  text,
  cantidad_fragmentos int    not null default 0,
  activo         boolean     not null default true,
  subido_por     uuid,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

drop trigger if exists documentos_tocar on public.documentos;
create trigger documentos_tocar before update on public.documentos
  for each row execute function public.tocar_actualizado_en();

-- Un mismo archivo subido dos veces no debe indexarse dos veces.
create unique index if not exists documentos_hash_unico
  on public.documentos (hash_sha256) where hash_sha256 is not null;

create index if not exists documentos_estado_idx on public.documentos (estado)
  where estado in ('pendiente','procesando');

comment on column public.documentos.activo is
  'Baja lógica: el panel lo oculta y el bot deja de citarlo, sin perder el historial.';

-- ---------------------------------------------------------------------------
-- Fragmentos indexados. Es la unidad que realmente se busca y se cita.
-- ---------------------------------------------------------------------------
create table if not exists public.fragmentos (
  id            uuid primary key default gen_random_uuid(),
  documento_id  uuid not null references public.documentos(id) on delete cascade,
  orden         int  not null,
  texto         text not null,
  pagina        int,
  titulo_seccion text,
  tokens_aprox  int,
  -- La columna generada mantiene el índice sincronizado sin trigger ni worker:
  -- es imposible que un fragmento quede indexado con texto viejo.
  busqueda      tsvector generated always as (
                  to_tsvector('public.es_sin_acentos', coalesce(titulo_seccion,'') || ' ' || texto)
                ) stored,
  creado_en     timestamptz not null default now(),
  unique (documento_id, orden)
);

create index if not exists fragmentos_busqueda_idx
  on public.fragmentos using gin (busqueda);
create index if not exists fragmentos_trigram_idx
  on public.fragmentos using gin (texto gin_trgm_ops);
create index if not exists fragmentos_documento_idx
  on public.fragmentos (documento_id);

-- ---------------------------------------------------------------------------
-- FAQs cargadas a mano desde el panel.
-- Participan de la búsqueda junto con los fragmentos, pero pesan más: una
-- respuesta escrita por un humano le gana a un pedazo de PDF.
-- ---------------------------------------------------------------------------
create table if not exists public.faqs (
  id            uuid primary key default gen_random_uuid(),
  pregunta      text not null,
  respuesta     text not null,
  etiquetas     text[] not null default '{}',
  prioridad     int  not null default 100,
  activa        boolean not null default true,
  veces_usada   int  not null default 0,
  -- Las etiquetas NO van acá: array_to_string() es STABLE, no IMMUTABLE, y
  -- Postgres rechaza la columna generada. Se indexan aparte con GIN sobre el
  -- array, que además da búsqueda exacta por etiqueta.
  -- setweight hace que la pregunta rankee por encima de la respuesta: si el
  -- vecino pregunta algo parecido a la pregunta de la FAQ, eso vale más que
  -- una coincidencia suelta en el cuerpo.
  busqueda      tsvector generated always as (
                  setweight(to_tsvector('public.es_sin_acentos', pregunta),  'A') ||
                  setweight(to_tsvector('public.es_sin_acentos', respuesta), 'B')
                ) stored,
  creada_por    uuid,
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

drop trigger if exists faqs_tocar on public.faqs;
create trigger faqs_tocar before update on public.faqs
  for each row execute function public.tocar_actualizado_en();

create index if not exists faqs_busqueda_idx on public.faqs using gin (busqueda);
create index if not exists faqs_pregunta_trigram_idx
  on public.faqs using gin (pregunta gin_trgm_ops);
-- Búsqueda por etiqueta: soporta etiquetas && array['puntos-verdes']
create index if not exists faqs_etiquetas_idx on public.faqs using gin (etiquetas);
create index if not exists faqs_activas_idx on public.faqs (activa, prioridad)
  where activa;

-- ---------------------------------------------------------------------------
-- Respuestas fijas: cortocircuito TOTAL del modelo.
--
-- Distintas de las FAQs a propósito. Una FAQ es material que el modelo lee
-- para redactar. Una respuesta fija se envía TEXTUAL, sin pasar por el modelo.
-- Es la herramienta para cuando la redacción institucional no es negociable
-- (plazos legales, montos, derivaciones formales) y no se puede permitir que
-- el modelo la parafrasee.
-- ---------------------------------------------------------------------------
create table if not exists public.respuestas_fijas (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  disparadores  text[] not null,
  modo          text not null default 'contiene'
                  check (modo in ('exacto','contiene','regex')),
  respuesta     text not null,
  prioridad     int  not null default 50,
  activa        boolean not null default true,
  veces_usada   int  not null default 0,
  notas         text,
  creada_por    uuid,
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  constraint respuestas_fijas_con_disparadores
    check (array_length(disparadores, 1) >= 1)
);

drop trigger if exists respuestas_fijas_tocar on public.respuestas_fijas;
create trigger respuestas_fijas_tocar before update on public.respuestas_fijas
  for each row execute function public.tocar_actualizado_en();

create index if not exists respuestas_fijas_activas_idx
  on public.respuestas_fijas (activa, prioridad) where activa;

comment on table public.respuestas_fijas is
  'Se envían textuales, sin pasar por el modelo. Para redacción institucional intocable.';
comment on column public.respuestas_fijas.prioridad is
  'Menor gana. Se evalúan antes que FAQs y documentos.';

-- >>>>>>>>>>>>>>>>>>>> 003_reglas.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 003 · Reglas de negocio COMO DATOS
-- ===========================================================================
-- Esta migración es el corazón de "Migue mejora desde el panel". Ni un límite,
-- ni un plazo, ni una palabra de derivación queda escrita en el código: si un
-- operador tiene que esperar un deploy para corregir un límite de bolsas, el
-- sistema falló.
--
-- Los borradores del cliente traen contradicciones sin resolver (SLA 72 vs
-- 48-72 hs, rechazo parcial vs derivación). Al estar en tablas, no hay que
-- adivinar: se carga un default razonable y Ambiente lo ajusta cuando defina.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Límites de volumen del servicio gratuito
-- ---------------------------------------------------------------------------
create table if not exists public.limites_volumen (
  categoria       text primary key
                    check (categoria in ('escombros','poda','voluminosos')),
  etiqueta        text not null,
  limite_valor    numeric not null check (limite_valor > 0),
  limite_unidad   text not null check (limite_unidad in ('bolsas','m3','kg','unidades')),
  peso_max_bolsa_kg numeric,
  -- La spec dice "rechazo parcial + ticket"; un borrador dice "derivar sin
  -- ticket". Configurable justamente porque el cliente todavía no lo definió.
  accion_al_exceder text not null default 'parcial_con_ticket'
                    check (accion_al_exceder in ('parcial_con_ticket','derivar_sin_ticket')),
  texto_exceso    text,
  activo          boolean not null default true,
  actualizado_en  timestamptz not null default now()
);

drop trigger if exists limites_volumen_tocar on public.limites_volumen;
create trigger limites_volumen_tocar before update on public.limites_volumen
  for each row execute function public.tocar_actualizado_en();

-- ---------------------------------------------------------------------------
-- Reglas de exclusión / derivación (filtros de entrada)
--
-- Se evalúan ANTES de cualquier flujo: si el vecino reporta olor a gas, no
-- corresponde preguntarle cuántas bolsas tiene.
-- ---------------------------------------------------------------------------
create table if not exists public.reglas_exclusion (
  id             uuid primary key default gen_random_uuid(),
  nombre         text not null unique,
  palabras       text[] not null,
  organismo      text,
  respuesta      text not null,
  -- 'derivar' cierra y deriva; 'advertir' informa pero deja seguir el flujo.
  accion         text not null default 'derivar'
                   check (accion in ('derivar','advertir')),
  prioridad      int  not null default 100,
  activa         boolean not null default true,
  veces_aplicada int  not null default 0,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  constraint reglas_exclusion_con_palabras
    check (array_length(palabras, 1) >= 1)
);

drop trigger if exists reglas_exclusion_tocar on public.reglas_exclusion;
create trigger reglas_exclusion_tocar before update on public.reglas_exclusion
  for each row execute function public.tocar_actualizado_en();

create index if not exists reglas_exclusion_activas_idx
  on public.reglas_exclusion (activa, prioridad) where activa;

comment on column public.reglas_exclusion.palabras is
  'Se comparan sobre el texto normalizado (sin acentos, minúsculas).';

-- ---------------------------------------------------------------------------
-- Puntos Verdes / Ecopuntos
--
-- El QA se queja de que el bot preguntaba horarios de más: los puntos de
-- contenedor son 24 hs. Por eso `horario` es texto libre y `materiales` es
-- lista: el bot responde con el dato, no con un interrogatorio.
-- ---------------------------------------------------------------------------
create table if not exists public.puntos_verdes (
  id            uuid primary key default gen_random_uuid(),
  -- `unique` es necesario, no cosmético: sin una clave natural, un
  -- `on conflict do nothing` sobre esta tabla no deduplica nada (el id es un
  -- uuid nuevo en cada insert) y las semillas se acumulan en cada corrida.
  nombre        text not null unique,
  direccion     text not null,
  tipo          text not null default 'contenedor'
                  check (tipo in ('contenedor','asistido','movil')),
  horario       text not null default '24 hs',
  materiales    text[] not null default '{}',
  observaciones text,
  latitud       numeric(9,6),
  longitud      numeric(9,6),
  activo        boolean not null default true,
  orden         int not null default 100,
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

drop trigger if exists puntos_verdes_tocar on public.puntos_verdes;
create trigger puntos_verdes_tocar before update on public.puntos_verdes
  for each row execute function public.tocar_actualizado_en();

create index if not exists puntos_verdes_activos_idx
  on public.puntos_verdes (activo, orden) where activo;

-- ---------------------------------------------------------------------------
-- Zonas y días de recolección
-- ---------------------------------------------------------------------------
create table if not exists public.zonas_recoleccion (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null unique,
  dias          text[] not null,
  hora_sacar    text,
  turno         text,
  observaciones text,
  activo        boolean not null default true,
  actualizado_en timestamptz not null default now()
);

drop trigger if exists zonas_recoleccion_tocar on public.zonas_recoleccion;
create trigger zonas_recoleccion_tocar before update on public.zonas_recoleccion
  for each row execute function public.tocar_actualizado_en();

comment on column public.zonas_recoleccion.hora_sacar is
  'Hora a partir de la cual el vecino puede sacar los residuos (ej. "14:30 hs").';

-- >>>>>>>>>>>>>>>>>>>> 004_conversaciones.sql <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>> 005_transaccional.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 005 · Tablas transaccionales existentes: extensión, no reemplazo
-- ===========================================================================
-- `tickets` y `program_requests` vienen del bot anterior (ManyChat) y tienen
-- 22 filas reales. Las conservo y las extiendo en vez de crear tablas nuevas:
-- migrar 22 filas no justifica duplicar el modelo.
--
-- Las columnas nuevas siguen la convención EN INGLÉS de esas tablas, para que
-- cada tabla sea coherente consigo misma. El resto del esquema va en español.
--
-- Hallazgo del relevamiento: `waste_type` y `quantity` están en null en TODAS
-- las filas. La spec exige tipificar y validar volumen, y el bot anterior nunca
-- lo capturaba — por eso aceptó el pedido del árbol caído. El flujo nuevo los
-- hace obligatorios en la aplicación.
-- ===========================================================================

alter table public.tickets
  add column if not exists channel            text,
  add column if not exists conversation_id    uuid references public.conversaciones(id) on delete set null,
  add column if not exists zone               text,
  add column if not exists quantity_value     numeric,
  add column if not exists quantity_unit      text,
  add column if not exists exceeds_limit      boolean not null default false,
  add column if not exists partial_pickup     boolean not null default false,
  add column if not exists derived_to         text,
  add column if not exists resolved_at        timestamptz,
  add column if not exists updated_at         timestamptz not null default now();

-- Las filas heredadas de ManyChat quedan marcadas como tal, para que las
-- métricas del panel puedan separar "antes" de "después" sin ambigüedad.
update public.tickets set channel = 'manychat' where channel is null;

-- `not valid` = no revalida las 22 filas heredadas, sólo exige la regla de acá
-- en adelante. El drop previo hace la migración re-ejecutable.
alter table public.tickets drop constraint if exists tickets_channel_valido;
alter table public.tickets
  add constraint tickets_channel_valido
    check (channel in ('telegram','whatsapp','web','manychat')) not valid;

create index if not exists tickets_estado_idx on public.tickets (status, created_at desc);
create index if not exists tickets_tipo_idx   on public.tickets (ticket_type);
create index if not exists tickets_conversacion_idx on public.tickets (conversation_id);
create index if not exists tickets_sla_idx on public.tickets (sla_deadline)
  where status <> 'Resuelto';

comment on column public.tickets.exceeds_limit is
  'El pedido superaba el límite gratuito. Con accion_al_exceder=parcial_con_ticket se registra igual.';
comment on column public.tickets.partial_pickup is
  'Se retira sólo hasta el máximo permitido; el excedente se derivó a Puntos Verdes.';

-- ---------------------------------------------------------------------------
alter table public.program_requests
  add column if not exists channel         text,
  add column if not exists conversation_id uuid references public.conversaciones(id) on delete set null,
  add column if not exists contact_phone   text,
  add column if not exists preferred_time  text,
  add column if not exists resolved_at     timestamptz,
  add column if not exists updated_at       timestamptz not null default now();

update public.program_requests set channel = 'manychat' where channel is null;

alter table public.program_requests drop constraint if exists program_requests_channel_valido;
alter table public.program_requests
  add constraint program_requests_channel_valido
    check (channel in ('telegram','whatsapp','web','manychat')) not valid;

create index if not exists program_requests_estado_idx
  on public.program_requests (status, created_at desc);
create index if not exists program_requests_tipo_idx
  on public.program_requests (program_type);
-- ---------------------------------------------------------------------------
-- Estas dos tablas usan `updated_at` (inglés), no `actualizado_en`, así que
-- necesitan su propia función de trigger. Duplicar cuatro líneas es preferible
-- a renombrar columnas de tablas que ya tienen datos productivos.
-- ---------------------------------------------------------------------------
create or replace function public.tocar_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists tickets_tocar on public.tickets;
create trigger tickets_tocar before update on public.tickets
  for each row execute function public.tocar_updated_at();

drop trigger if exists program_requests_tocar on public.program_requests;
create trigger program_requests_tocar before update on public.program_requests
  for each row execute function public.tocar_updated_at();

-- >>>>>>>>>>>>>>>>>>>> 006_trabajos.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 006 · Cola de trabajos (panel -> worker en la VPS)
-- ===========================================================================
-- Este mecanismo es lo que evita exponer un puerto en la VPS. El panel no
-- llama a la VPS: escribe una fila acá. El worker la consume.
--
-- Beneficio lateral importante: si el worker está caído, el trabajo queda
-- encolado en vez de fallar. Con una API HTTP, la subida del documento
-- fracasaba y el operador tenía que reintentar.
-- ===========================================================================

create table if not exists public.trabajos (
  id            uuid primary key default gen_random_uuid(),
  tipo          text not null check (tipo in
                  ('ingestar_documento','reindexar_documento','borrar_documento','reindexar_todo')),
  payload       jsonb not null default '{}',
  estado        text not null default 'pendiente'
                  check (estado in ('pendiente','tomado','listo','error')),
  intentos      int  not null default 0,
  max_intentos  int  not null default 3,
  error_detalle text,
  prioridad     int  not null default 100,
  -- `tomado_por` + `tomado_en` permiten detectar un worker que murió a mitad
  -- de un trabajo y devolver la fila a la cola.
  tomado_por    text,
  tomado_en     timestamptz,
  creado_en     timestamptz not null default now(),
  finalizado_en timestamptz,
  creado_por    uuid
);

create index if not exists trabajos_pendientes_idx
  on public.trabajos (prioridad, creado_en) where estado = 'pendiente';
create index if not exists trabajos_tomados_idx
  on public.trabajos (tomado_en) where estado = 'tomado';

-- ---------------------------------------------------------------------------
-- Toma atómica de trabajo.
--
-- FOR UPDATE SKIP LOCKED es lo que hace que esto sea seguro con varios workers:
-- cada uno se lleva una fila distinta sin bloquearse entre ellos. Sin SKIP
-- LOCKED, dos workers se pelean por la misma fila y uno queda esperando.
-- ---------------------------------------------------------------------------
create or replace function public.tomar_trabajo(p_worker text)
returns setof public.trabajos
language plpgsql as $$
begin
  return query
  update public.trabajos t
     set estado     = 'tomado',
         tomado_por = p_worker,
         tomado_en  = now(),
         intentos   = t.intentos + 1
   where t.id = (
     select id from public.trabajos
      where estado = 'pendiente'
      order by prioridad, creado_en
      for update skip locked
      limit 1
   )
  returning t.*;
end $$;

-- Un worker que muere deja su trabajo en 'tomado' para siempre. Esto lo
-- devuelve a la cola si pasó demasiado tiempo, o lo marca en error si ya
-- agotó los intentos.
create or replace function public.recuperar_trabajos_colgados(p_minutos int default 15)
returns int language plpgsql as $$
declare v_recuperados int;
begin
  with recuperados as (
    update public.trabajos
       set estado = case when intentos >= max_intentos then 'error' else 'pendiente' end,
           error_detalle = case when intentos >= max_intentos
                                then 'El worker no respondió tras ' || intentos || ' intentos'
                                else error_detalle end,
           tomado_por = null,
           tomado_en  = null
     where estado = 'tomado'
       and tomado_en < now() - make_interval(mins => p_minutos)
    returning 1
  )
  select count(*) into v_recuperados from recuperados;
  return v_recuperados;
end $$;

comment on function public.tomar_trabajo is
  'Toma un trabajo de forma atómica. Seguro con múltiples workers (SKIP LOCKED).';

-- >>>>>>>>>>>>>>>>>>>> 007_rls.sql <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>> 008_semillas.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 008 · Semillas: reglas y textos tomados de la Especificación Funcional MVP
-- ===========================================================================
-- Los textos son TEXTUALES de la spec. Donde la spec y los borradores se
-- contradicen tomo la spec (documento "Especificaciones MVP Ambiente") y lo
-- dejo anotado, porque son decisiones que Ambiente todavía debe confirmar.
--
-- Todo es idempotente (on conflict do nothing): re-ejecutar no pisa ediciones
-- hechas desde el panel. Es deliberado — una vez que un operador corrigió un
-- texto, una migración no debe volver a aplastarlo.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Configuración operativa
-- ---------------------------------------------------------------------------
insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('sla_horas_habiles', '72'::jsonb,
   'Plazo que el bot comunica. La spec dice 72 hs hábiles; un borrador dice 48-72. PENDIENTE de confirmación de Ambiente.', 'negocio'),
  ('empresa_recoleccion', '"Transporte 9 de Julio"'::jsonb,
   'Empresa prestataria del servicio de recolección.', 'negocio'),
  ('foto_obligatoria_retiro', 'true'::jsonb,
   'Flujo A: la foto es bloqueante. PENDIENTE: los borradores preguntan si hay excepciones.', 'negocio'),
  ('foto_sugerida_reclamo', 'true'::jsonb,
   'Flujo B: la foto se pide pero no bloquea.', 'negocio'),
  ('modelo_router', '"openai/gpt-4o-mini"'::jsonb,
   'Modelo de OpenRouter para clasificar intención y extraer datos. Se cambia desde el panel sin deploy.', 'ia'),
  ('modelo_respuesta', '"anthropic/claude-3.5-sonnet"'::jsonb,
   'Modelo de OpenRouter para redactar la respuesta final.', 'ia'),
  ('umbral_confianza', '0.55'::jsonb,
   'Por debajo de esto no se responde: se registra en sin_respuesta. Preferimos callar antes que inventar.', 'ia'),
  ('max_fragmentos_contexto', '8'::jsonb,
   'Cuántos fragmentos se le pasan al modelo. El corpus es chico, se puede ser generoso.', 'ia'),
  ('expansion_consulta_activa', 'true'::jsonb,
   'Reescribe la pregunta del vecino a términos del corpus antes de buscar. Sube mucho el recall de FTS.', 'ia'),
  ('responder_antes_de_preguntar', 'true'::jsonb,
   'Regla que sale del QA del bot anterior: si la intención ya es clara, contestar directo sin imponer el menú.', 'negocio')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- Límites de volumen (Anexo de Datos de la spec)
-- ---------------------------------------------------------------------------
insert into public.limites_volumen
  (categoria, etiqueta, limite_valor, limite_unidad, peso_max_bolsa_kg, accion_al_exceder, texto_exceso) values
  ('escombros', 'Escombros / Material de construcción', 5, 'bolsas', 15, 'parcial_con_ticket',
   'Tu pedido excede el límite del servicio gratuito. Retiraremos hasta el máximo permitido. El resto debés llevarlo a un Punto Verde o contratar un contenedor privado.'),
  ('poda', 'Restos de Poda / Ramas', 10, 'bolsas', null, 'parcial_con_ticket',
   'Tu pedido excede el límite del servicio gratuito de poda. Retiraremos hasta el máximo permitido. El excedente podés acercarlo a un Punto Verde.'),
  ('voluminosos', 'Voluminosos (muebles, electrodomésticos, chatarra, ramas enfardadas)', 1, 'm3', null, 'parcial_con_ticket',
   'Tu pedido excede 1 m³, que es el límite del servicio gratuito. Retiraremos hasta el máximo permitido; el resto debés gestionarlo por Punto Verde o contenedor privado.')
on conflict (categoria) do nothing;

-- ---------------------------------------------------------------------------
-- Zonas de recolección (Anexo de Datos de la spec)
-- ---------------------------------------------------------------------------
insert into public.zonas_recoleccion (nombre, dias, hora_sacar, observaciones) values
  ('Zona Norte', array['lunes','martes','viernes'], '14:30 hs',
   'Los residuos se sacan a las 14:30 hs del día que corresponde, y sólo después de la confirmación del retiro.'),
  ('Zona Sur',   array['martes','jueves','sabado'], '14:30 hs',
   'Los residuos se sacan a las 14:30 hs del día que corresponde, y sólo después de la confirmación del retiro.')
on conflict (nombre) do nothing;

-- ---------------------------------------------------------------------------
-- Puntos Verdes
-- Sólo los 3 que nombra la spec. El listado oficial completo (con horarios y
-- qué recibe cada punto) está PENDIENTE: los borradores lo piden expresamente.
-- El horario 24 hs de los puntos de contenedor sale del documento de QA.
-- ---------------------------------------------------------------------------
insert into public.puntos_verdes (nombre, direccion, tipo, horario, materiales, orden) values
  ('Punto Verde Lamadrid', 'Lamadrid 3700',                 'contenedor', '24 hs', array['reciclables','neumaticos'], 10),
  ('Punto Verde Viamonte', 'Viamonte e Italia',             'contenedor', '24 hs', array['reciclables','neumaticos'], 20),
  ('Punto Verde Lillo',    'Miguel Lillo e Inca Garcilaso', 'contenedor', '24 hs', array['reciclables','neumaticos'], 30)
on conflict (nombre) do nothing;

-- ---------------------------------------------------------------------------
-- Reglas de exclusión y derivación
-- Prioridad menor = se evalúa primero. Gas va primero por seguridad: un olor a
-- gas no puede quedar detrás de ninguna otra regla.
-- ---------------------------------------------------------------------------
insert into public.reglas_exclusion (nombre, palabras, organismo, respuesta, accion, prioridad) values
  ('Fuga de gas',
   array['gas','olor a gas','escape de gas','cano roto','medidor','naturgy','gasnor'],
   'Naturgy / Gasnor',
   'Si sentís olor a gas, alejate del lugar y no acciones interruptores. Este tipo de reclamo no corresponde a la competencia municipal: comunicate de inmediato con Naturgy o Gasnor.',
   'derivar', 10),

  ('Agua y cloacas (SAT)',
   array['agua','perdida de agua','cloaca','desborde','presion','sat','aguas del tucuman'],
   'SAT — Aguas del Tucumán',
   'Te informamos que ese tipo de reclamo no corresponde a la competencia municipal. Corresponde al SAT (Aguas del Tucumán).',
   'derivar', 20),

  ('Alumbrado público',
   array['alumbrado','luz de la calle','foco quemado','farola','poste de luz'],
   'Alumbrado Público',
   'Ese reclamo corresponde al área de Alumbrado Público y no se gestiona por este canal.',
   'derivar', 30),

  ('Arbol caido o rama de gran porte',
   array['arbol caido','se cayo un arbol','arbol sobre','rama enorme','rama gigante','tronco','arbol partido','poda de altura'],
   'Arbolado / Limpieza Urbana',
   'Por las dimensiones, esto corresponde al área de Arbolado y Limpieza Urbana, no al retiro de residuos no habituales. Lo derivamos para que lo evalúe una cuadrilla.',
   'derivar', 40),

  ('Neumaticos',
   array['neumatico','neumaticos','cubierta','cubiertas','goma de auto','llanta'],
   null,
   'El retiro de neumáticos a domicilio está suspendido. Podés dejarlos en cualquier Punto Verde de contenedor, que funcionan las 24 hs.',
   'derivar', 50),

  ('Residuos peligrosos o patogenicos',
   array['residuo peligroso','patogenico','jeringa','quimico','acido','solvente','asbesto','amianto','animal muerto','pila','bateria'],
   'Ambiente — Residuos Especiales',
   'Ese tipo de residuo requiere un tratamiento especial y no se retira por este circuito. Un agente de Ambiente va a contactarte para indicarte cómo gestionarlo.',
   'derivar', 60),

  ('Infracciones de vecinos o vehiculos',
   array['denuncia','multa','infraccion','mi vecino','auto abandonado','tira basura'],
   null,
   'Las denuncias por infracciones no se gestionan por este canal en esta etapa. Podés realizarlas en la sede de la Dirección correspondiente.',
   'derivar', 70)
on conflict (nombre) do nothing;

-- ---------------------------------------------------------------------------
-- Textos del bot — TEXTUALES de la spec donde ésta los define
-- ---------------------------------------------------------------------------
insert into public.textos_bot (clave, texto, descripcion) values
  ('bienvenida',
   E'Hola, soy Migue Ambiente \U0001F331 de la Municipalidad de San Miguel de Tucumán.\n\nPuedo ayudarte con retiro de residuos especiales, reclamos de recolección, programas ambientales y Puntos Verdes.\n\nContame qué necesitás.',
   'Primer mensaje. No impone el menú: el vecino puede escribir directamente lo que necesita.'),

  ('menu_principal',
   E'Decime cuál de estas opciones te sirve:\n\n1. Retiro de residuos especiales (poda, escombros, muebles)\n2. El camión no pasó\n3. Programas ambientales (SEPARÁ, EDUCÁ, TRANSFORMÁ, Puntos Verdes)\n4. Otra consulta\n\nO escribime directamente tu consulta.',
   'Menú de las 4 ramas. Se muestra SÓLO si la intención no quedó clara.'),

  ('retiro_requisitos',
   E'Para gestionar este pedido especial (no es el retiro diario), necesito que tengas a mano una foto de lo que hay que retirar y tu dirección exacta.\n\n⚠️ Regla de Oro: NO saques los residuos a la vereda todavía. Esperá nuestra confirmación de día y horario (usualmente a las 14:30 hs según tu zona).',
   'Flujo A, paso A1. Textual de la spec.'),

  ('retiro_pedir_foto',
   'Por favor, enviame ahora la foto de los residuos.',
   'Flujo A, paso A2. Textual de la spec.'),

  ('retiro_foto_faltante',
   'Necesito una imagen para coordinar el retiro. Sin la foto no puedo saber qué camión enviar.',
   'Flujo A, reintento de foto. Se repite hasta recibir imagen.'),

  ('retiro_pedir_tipo',
   '¿Qué tipo de residuo es y qué cantidad aproximada?',
   'Flujo A, paso A3. Textual de la spec.'),

  ('retiro_pedir_direccion',
   'Indicame la Dirección Exacta (Calle y Número) y entre qué calles se encuentra.',
   'Flujo A, paso A4. Textual de la spec.'),

  ('retiro_confirmacion',
   E'✅ Solicitud registrada. La empresa tiene un plazo de hasta 72 hs hábiles.\n\nZona Norte: recolección Lun, Mar, Vie.\nZona Sur: recolección Mar, Jue, Sáb.\n\nPodrás sacar los residuos a las 14:30 hs del día que corresponda a tu zona una vez que te confirmemos.',
   'Flujo A, paso A5. Textual de la spec.'),

  ('reclamo_diagnostico',
   E'Para verificar el recorrido del camión necesito tres cosas:\n\n- Tu dirección exacta\n- Una foto de la basura no recolectada (opcional, pero ayuda)\n- ¿Desde cuándo no pasa el servicio?',
   'Flujo B, paso B1.'),

  ('reclamo_confirmacion',
   'Reclamo generado. Verificaremos el GPS del interno. Si hubo una falla, la empresa tiene 72 hs hábiles para normalizar el servicio.',
   'Flujo B, paso B3. Textual de la spec.'),

  ('separa_info',
   'El servicio SEPARÁ pasa los Miércoles y Sábados de 09 a 12 hs (dentro de las 4 avenidas). Dejá tus reciclables limpios y secos.',
   'Flujo C, SEPARÁ. Textual de la spec.'),

  ('separa_fuera_de_avenidas',
   'Tu domicilio está fuera de las 4 avenidas. Para coordinar el retiro necesito: tu nombre, teléfono, dirección exacta, una foto de los reciclables limpios, qué materiales son y en qué franja horaria estás.',
   'Sale del documento de QA: pedido explícito del área para domicilios fuera de las 4 avenidas.'),

  ('educa_requisitos',
   'Para solicitar un taller o una visita del programa EDUCÁ necesito: nombre de la institución, dirección, responsable a cargo y cantidad de alumnos.',
   'Flujo C, EDUCÁ.'),

  ('transforma_requisitos',
   'Para murales o carteles del programa TRANSFORMÁ necesito la dirección exacta y fotos de la zona para el relevamiento.',
   'Flujo C, TRANSFORMÁ.'),

  ('sin_respuesta',
   'No tengo esa información con la certeza suficiente para respondértela. Ya la registré para que el equipo de Ambiente la revise. Si es urgente, podés escribir a la Dirección de Ambiente.',
   'Fallback. Preferimos admitir el límite antes que inventar un dato municipal.'),

  ('fuera_de_alcance',
   'Te informamos que ese tipo de reclamo no corresponde a la competencia municipal.',
   'Respuesta genérica de exclusión. Textual de la spec.')
on conflict (clave) do nothing;
