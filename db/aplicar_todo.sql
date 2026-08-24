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
-- `drop` y no `create or replace`: la migración 017 le cambia las columnas a
-- esta vista, y `create or replace view` no puede cambiar la lista de columnas
-- —falla con «cannot drop columns from view»—. Sin esto, volver a aplicar el
-- esquema completo sobre una base que ya tiene la 017 se rompe en esta línea.
drop view if exists public.v_auditoria_rls;
create view public.v_auditoria_rls as
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

-- >>>>>>>>>>>>>>>>>>>> 009_modelos_y_sla.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 009 · Corrección de modelos de IA y claves de SLA que faltaban
-- ===========================================================================
-- Dos arreglos que salieron de verificar contra las APIs reales en vez de
-- confiar en la memoria.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · El modelo de redacción sembrado NO EXISTE en OpenRouter
--
-- La migración 008 cargó `anthropic/claude-3.5-sonnet`. Consultando el
-- catálogo real de OpenRouter (414 modelos), ese ID no está: habría fallado
-- recién cuando un vecino escribiera una consulta libre.
--
-- Reemplazo por `anthropic/claude-haiku-4.5` (1,00 / 5,00 USD por millón de
-- tokens, contexto de 200k). Con un corpus de 16k tokens sobra, y sale unos
-- 0,0045 USD por respuesta.
--
-- La condición sobre el valor viejo es deliberada: si un operador ya eligió
-- otro modelo desde el panel, esta migración no le pisa la decisión.
-- ---------------------------------------------------------------------------
update public.configuracion
   set valor = '"anthropic/claude-haiku-4.5"'::jsonb,
       descripcion = 'Modelo de OpenRouter para redactar la respuesta final. Verificado contra el catálogo real. Alternativa de mayor calidad: anthropic/claude-sonnet-5.'
 where clave = 'modelo_respuesta'
   and valor = '"anthropic/claude-3.5-sonnet"'::jsonb;

-- El router sí existía; sólo se aclara la descripción con el costo medido.
update public.configuracion
   set descripcion = 'Modelo de OpenRouter para clasificar intención y extraer datos. Corre en cada mensaje; a 0,15/0,60 USD por millón el costo es despreciable frente al riesgo de clasificar mal.'
 where clave = 'modelo_router';

-- ---------------------------------------------------------------------------
-- 2 · Claves de SLA que el código lee pero la semilla no cargaba
--
-- `configSla()` en @migue/dominio lee estas cinco claves. Sin las filas, el
-- código cae a sus valores por defecto y funciona igual — pero el panel no
-- puede editarlas, que es justamente el punto de tener las reglas como datos.
--
-- El modo por defecto es `dias_habiles`: el bot anterior calculaba 72 horas
-- corridas y prometía vencimientos en domingo. Ver el README de @migue/dominio.
-- ---------------------------------------------------------------------------
insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('sla_modo', '"dias_habiles"'::jsonb,
   'Cómo interpretar el plazo. dias_habiles = 72/24 = 3 días hábiles (default). horas_corridas = 72 h de reloj, lo que hacía el bot anterior y caía en domingo. horas_habiles = 72 h de jornada laboral, unos 9 días laborables. PENDIENTE de confirmación de Ambiente.',
   'negocio'),

  ('sla_sabado_habil', 'true'::jsonb,
   'El sábado cuenta como día hábil. Verdadero por defecto porque la recolección de Zona Sur trabaja los sábados según el anexo de la spec. Difiere del calendario administrativo.',
   'negocio'),

  ('sla_jornada_desde', '8'::jsonb,
   'Hora de inicio de jornada, hora local. Sólo se usa en modo horas_habiles.',
   'negocio'),

  ('sla_jornada_hasta', '16'::jsonb,
   'Hora de fin de jornada, hora local. Sólo se usa en modo horas_habiles.',
   'negocio'),

  ('feriados', '[]'::jsonb,
   'Feriados en formato YYYY-MM-DD que corren el vencimiento del plazo. Cargar los nacionales y provinciales de Tucumán.',
   'negocio')
on conflict (clave) do nothing;

-- >>>>>>>>>>>>>>>>>>>> 010_palabras_categoria.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 010 · Palabras clave por categoría de residuo
-- ===========================================================================
-- El flujo A tiene que decidir si «tengo unos ladrillos y revoque» es
-- escombros, poda o voluminosos, para saber contra qué límite compararlo.
--
-- Las palabras van en la tabla y no en el código por el mismo motivo que todo
-- lo demás: el vocabulario real de los vecinos es local y cambia. Alguien de
-- Ambiente va a querer agregar «changuito», «carretilla» o el nombre de un
-- material que acá no figura, sin esperar un deploy.
-- ===========================================================================

alter table public.limites_volumen
  add column if not exists palabras text[] not null default '{}';

comment on column public.limites_volumen.palabras is
  'Palabras que identifican la categoría en el texto del vecino. Se comparan normalizadas (sin acentos, minúsculas) y por palabra completa.';

-- Se usa `where palabras = '{}'` para no pisar el vocabulario que Ambiente
-- haya ampliado desde el panel.
update public.limites_volumen set palabras = array[
  'escombro','escombros','material de construccion','ladrillo','ladrillos',
  'cemento','arena','cascote','cascotes','revoque','mamposteria','obra',
  'demolicion','baldosa','baldosas','mortero','hormigon'
] where categoria = 'escombros' and palabras = '{}';

update public.limites_volumen set palabras = array[
  'poda','rama','ramas','pasto','cesped','hoja','hojas','arbusto','arbustos',
  'planta','plantas','yuyo','yuyos','maleza','follaje','ligustro','enredadera'
] where categoria = 'poda' and palabras = '{}';

update public.limites_volumen set palabras = array[
  'mueble','muebles','sillon','sillones','silla','sillas','colchon','colchones',
  'heladera','ropero','placard','mesa','mesas','chatarra','electrodomestico',
  'electrodomesticos','tarima','tarimas','voluminoso','voluminosos','somier',
  'lavarropas','televisor','estufa','cocina','bacha','inodoro'
] where categoria = 'voluminosos' and palabras = '{}';

-- >>>>>>>>>>>>>>>>>>>> 011_textos_con_marcadores.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 011 · Marcadores en los textos que mencionan el plazo
-- ===========================================================================
-- La migración 008 sembró los textos TEXTUALES de la spec, y ahí el plazo está
-- escrito a mano: «La empresa tiene un plazo de hasta 72 hs hábiles».
--
-- Pero desde la migración 009 el plazo es configurable, con tres modos que dan
-- resultados separados por diez días. Con el texto fijo, un operador que
-- cambie `sla_modo` deja al bot prometiendo «72 hs hábiles» mientras el ticket
-- vence en otra fecha. El vecino recibe una promesa que el sistema no registró.
--
-- Los marcadores lo resuelven: el texto se escribe una vez y siempre dice lo
-- mismo que el ticket. Disponibles: {plazo}, {vencimiento}, {empresa},
-- {direccion}.
--
-- Las condiciones sobre el valor viejo son deliberadas: si Comunicación ya
-- reescribió el mensaje, esta migración no le pisa la redacción.
-- ===========================================================================

update public.textos_bot
   set texto = E'✅ Solicitud registrada. {empresa} tiene un plazo de hasta {plazo} (vence el {vencimiento}).\n\nZona Norte: recolección Lun, Mar, Vie.\nZona Sur: recolección Mar, Jue, Sáb.\n\nPodrás sacar los residuos a las 14:30 hs del día que corresponda a tu zona una vez que te confirmemos.',
       descripcion = 'Flujo A, paso A5. Usa marcadores {empresa}, {plazo} y {vencimiento} para no contradecir el plazo configurado.'
 where clave = 'retiro_confirmacion'
   and texto like '%72 hs hábiles%';

update public.textos_bot
   set texto = 'Reclamo generado. Verificaremos el GPS del interno. Si hubo una falla, {empresa} tiene {plazo} para normalizar el servicio.',
       descripcion = 'Flujo B, paso B3. Usa marcadores {empresa} y {plazo}.'
 where clave = 'reclamo_confirmacion'
   and texto like '%72 hs hábiles%';

-- Documentar los marcadores disponibles, para que quien edite desde el panel
-- sepa que existen en lugar de escribir el dato a mano otra vez.
insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('marcadores_disponibles',
   '["{plazo}","{vencimiento}","{empresa}","{direccion}"]'::jsonb,
   'Marcadores que se pueden usar en los textos del bot. Se reemplazan al enviar. Un marcador mal escrito queda visible en el mensaje, así se detecta en la primera prueba.',
   'referencia')
on conflict (clave) do nothing;

-- >>>>>>>>>>>>>>>>>>>> 012_referencia_de_foto.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 012 · Referencia de foto separada de la URL final
-- ===========================================================================
-- El flujo captura un `file_id` de Telegram, que NO es una URL: es un
-- identificador que sólo sirve contra la API del canal de origen. El worker lo
-- descarga después y lo sube a Supabase Storage, y ahí sí hay URL.
--
-- Reutilizar `photo_url` para las dos cosas dejaría al panel sin saber si el
-- valor que tiene es algo que puede mostrar o algo que todavía no se procesó.
-- Con dos columnas la respuesta es obvia: si `photo_url` está en null y
-- `photo_ref` no, la foto está en camino.
-- ===========================================================================

alter table public.tickets
  add column if not exists photo_ref text;

comment on column public.tickets.photo_ref is
  'Referencia del archivo en el canal de origen (file_id de Telegram). El worker la resuelve y llena photo_url.';
comment on column public.tickets.photo_url is
  'URL pública en Supabase Storage. Null mientras el worker no haya descargado la foto.';

-- Permite al worker encontrar rápido lo que le falta procesar.
create index if not exists tickets_foto_pendiente_idx
  on public.tickets (created_at)
  where photo_ref is not null and photo_url is null;

alter table public.program_requests
  add column if not exists photo_ref text,
  add column if not exists photo_url text;

comment on column public.program_requests.photo_ref is
  'Referencia del archivo en el canal de origen. Aplica sobre todo a TRANSFORMÁ (fotos de relevamiento) y SEPARÁ.';

-- ---------------------------------------------------------------------------
-- Ventana de conversación
-- ---------------------------------------------------------------------------
-- Si un vecino escribe de nuevo tres días después, no es la misma
-- conversación: reutilizarla mezclaría dos consultas distintas en un mismo
-- hilo y falsearía las métricas de duración y de mensajes por conversación.
insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('conversacion_ventana_horas', '24'::jsonb,
   'Horas de inactividad tras las que una conversación abierta se considera terminada y el próximo mensaje abre una nueva.',
   'negocio')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- Tipo de trabajo para descargar media de un canal
-- ---------------------------------------------------------------------------
-- Usar `ingestar_documento` para bajar la foto de un vecino sería mentirle al
-- panel: son dos cosas distintas con prioridades distintas. Detrás de una foto
-- hay alguien esperando respuesta; detrás de un PDF del panel no.
alter table public.trabajos drop constraint if exists trabajos_tipo_check;
alter table public.trabajos
  add constraint trabajos_tipo_check check (tipo in (
    'ingestar_documento',
    'reindexar_documento',
    'borrar_documento',
    'reindexar_todo',
    'descargar_media'
  ));

-- >>>>>>>>>>>>>>>>>>>> 013_agrupar_sin_respuesta.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 013 · Agrupación de preguntas sin responder
-- ===========================================================================
-- `sin_respuesta` es la tabla más valiosa del sistema: cada fila es un vecino
-- que se fue sin respuesta, y el panel permite resolverla creando una FAQ.
--
-- Pero sin agrupar no sirve. Cincuenta vecinos preguntando lo mismo se ven
-- como cincuenta problemas distintos en lugar del único que son, y quien
-- revise el panel no puede saber qué conviene resolver primero.
--
-- Por qué una función en la base y no lógica en la aplicación:
--
--   1. El operador de similitud trigram (%) no se expresa bien por PostgREST.
--   2. Resolverlo en dos viajes —buscar parecida, después insertar— abre una
--      carrera: dos mensajes simultáneos con la misma pregunta no se ven entre
--      sí y crean dos filas. Acá es una sola sentencia atómica.
-- ===========================================================================

-- Se borran las sobrecargas antes de crear: `create or replace` con una firma
-- distinta no reemplaza, crea otra función con el mismo nombre. Es regla del
-- proyecto para toda función RPC de este esquema.
do $$
declare f record;
begin
  for f in select oid::regprocedure as firma from pg_proc
            where pronamespace = 'public'::regnamespace
              and proname = 'agrupar_sin_respuesta'
  loop execute format('drop function %s', f.firma); end loop;
end $$;

create function public.agrupar_sin_respuesta(
  p_pregunta        text,
  p_motivo          text,
  p_conversacion_id uuid    default null,
  p_mensaje_id      uuid    default null,
  p_confianza       numeric default null,
  p_umbral          real    default 0.6
)
returns table (id uuid, agrupada boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existente uuid;
begin
  -- `set_limit` fija el umbral que usa el operador % en esta sesión.
  perform set_limit(p_umbral);

  -- Se busca sólo entre las PENDIENTES: una pregunta ya resuelta que vuelve a
  -- aparecer es señal de que la FAQ no alcanzó, y merece fila propia para que
  -- se vea que el arreglo no funcionó.
  select s.id into v_existente
    from public.sin_respuesta s
   where s.estado = 'pendiente'
     and s.pregunta % p_pregunta
   order by similarity(s.pregunta, p_pregunta) desc
   limit 1;

  if v_existente is not null then
    update public.sin_respuesta
       set veces_repetida = veces_repetida + 1,
           actualizado_en = now()
     where public.sin_respuesta.id = v_existente;
    return query select v_existente, true;
    -- `return query` NO termina la función: acumula filas y sigue. Sin este
    -- `return`, la ejecución caía en el INSERT de abajo, insertaba una fila
    -- duplicada además de incrementar el contador, y devolvía DOS filas.
    return;
  end if;

  -- El INSERT va dentro de un WITH porque en plpgsql un `insert ... returning`
  -- no puede devolver filas por sí mismo dentro de una función `returns table`
  -- (falla con «query has no destination for result data»). Envolverlo hace
  -- que la sentencia externa sea un SELECT, que sí puede.
  return query
    with nueva as (
      insert into public.sin_respuesta
        (pregunta, motivo, conversacion_id, mensaje_id, confianza)
      values
        (p_pregunta, p_motivo, p_conversacion_id, p_mensaje_id, p_confianza)
      returning public.sin_respuesta.id
    )
    select nueva.id, false from nueva;
end $$;

comment on function public.agrupar_sin_respuesta(text, text, uuid, uuid, numeric, real) is
  'Registra una pregunta sin responder agrupándola con una pendiente parecida (trigram). Atómica: evita filas duplicadas por mensajes simultáneos.';

-- El índice trigram que hace rápida la búsqueda ya existe desde la migración
-- 004 (sin_respuesta_pregunta_trigram_idx). Este índice parcial acelera el
-- filtro por estado, que es el que más se consulta desde el panel.
create index if not exists sin_respuesta_pendientes_repetidas_idx
  on public.sin_respuesta (veces_repetida desc, creado_en desc)
  where estado = 'pendiente';

-- >>>>>>>>>>>>>>>>>>>> 014_buscar_conocimiento.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 014 · Búsqueda de conocimiento
-- ===========================================================================
-- Busca en FAQs y en fragmentos de documentos a la vez, con ranking unificado.
--
-- Va como función en la base y no como consultas desde la aplicación por tres
-- razones concretas:
--
--   1. `ts_rank` no se puede usar para ordenar desde PostgREST.
--   2. Unir dos tablas con rankings comparables requiere un UNION con la
--      misma expresión de ranking en las dos ramas.
--   3. El respaldo por similitud trigram —para cuando el vecino escribe con
--      errores y el FTS no encuentra nada— necesita ejecutarse condicionalmente
--      según el resultado de la primera búsqueda. Dos viajes de red para eso
--      serían dos veces la latencia mientras alguien espera respuesta.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Se borran TODAS las sobrecargas antes de crear.
--
-- `create or replace function` con una firma distinta no reemplaza: crea una
-- sobrecarga nueva y deja la vieja viva. Esta migración cambió de firma al
-- agregar `p_terminos`, y el resultado fue dos funciones con el mismo nombre —
-- que además hace fallar cualquier `comment on function` sin lista de
-- argumentos, con «function name is not unique».
--
-- El arnés de validación local no puede detectar esto: crea una base nueva en
-- cada corrida, así que nunca hay una versión anterior con la que chocar. Por
-- eso conviene que TODA función de este esquema se borre antes de crearse.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select oid::regprocedure as firma
      from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'buscar_conocimiento'
  loop
    execute format('drop function %s', f.firma);
  end loop;
end $$;

create function public.buscar_conocimiento(
  p_consulta   text,
  -- Términos de la expansión, separados por espacios. Opcional.
  --
  -- Van aparte de la consulta y NO concatenados, por una razón que costó un
  -- bug: `websearch_to_tsquery` une los términos con AND. Pegar los términos
  -- expandidos a la consulta hacía la búsqueda MÁS restrictiva —exigía que
  -- aparecieran todos— cuando el objetivo de expandir es exactamente el
  -- contrario. Acá se usan para armar una consulta OR aparte.
  p_terminos   text default null,
  p_limite     int  default 8,
  -- Cuánto pesa más una FAQ que un fragmento de PDF. Una respuesta escrita por
  -- un humano del área le gana a un pedazo de documento institucional: ya está
  -- redactada para un vecino y alguien la revisó.
  p_impulso_faq real default 2.0,
  -- Umbral del respaldo difuso, sobre `word_similarity`.
  --
  -- 0.35 sale de medir, no de estimar. Con la consulta «recoridro del camoin»
  -- contra «¿Cómo verifico el recorrido del camión?»:
  --   similarity      0.295  — y las FAQs de ruido daban hasta 0.100
  --   word_similarity 0.520  — y el ruido no pasaba de 0.143
  -- `similarity` penaliza que la pregunta sea más larga que la consulta, así
  -- que la coincidencia correcta quedaba a 0.005 de perderse. `word_similarity`
  -- compara contra la mejor porción de la pregunta y deja el margen holgado.
  p_umbral_difuso real default 0.35
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
-- volatile (el default) y no stable: la función llama a set_limit(), que
-- modifica estado de sesión. Declararla stable sería mentir sobre eso.
security definer
set search_path = public
as $$
declare
  v_consulta tsquery;
  v_amplia   tsquery;
  v_palabras text;
  -- Se pregunta explícitamente si hay resultados en vez de leer ROW_COUNT
  -- después de un RETURN QUERY. plpgsql no documenta claramente esa
  -- combinación, y una suposición sobre este lenguaje ya costó dos errores en
  -- producción. Un EXISTS cuesta poco y no deja lugar a dudas.
  v_hay_resultados boolean;
begin
  -- Nivel 1 · PRECISIÓN. websearch_to_tsquery une con AND: exige que
  -- aparezcan todos los términos. Cuando encuentra algo, es lo más relevante.
  v_consulta := websearch_to_tsquery('public.es_sin_acentos', coalesce(p_consulta, ''));

  if v_consulta is null or numnode(v_consulta) = 0 then
    return;
  end if;

  select exists (
    select 1 from public.faqs f where f.activa and f.busqueda @@ v_consulta
    union all
    select 1
      from public.fragmentos fr
      join public.documentos d on d.id = fr.documento_id
     where d.activo and d.estado = 'listo' and fr.busqueda @@ v_consulta
  ) into v_hay_resultados;

  -- Nivel 2 · RECALL. Si el AND no encontró nada, se prueba con OR sobre la
  -- consulta más los términos expandidos. `ts_rank` se encarga de ordenar: un
  -- documento que coincide en más términos rankea más alto, así que abrir a OR
  -- no arruina la relevancia, sólo amplía el conjunto candidato.
  if not v_hay_resultados then
    -- Se sanea antes de armar la consulta: to_tsquery se rompe con paréntesis
    -- o signos, y estos términos los escribió un modelo de lenguaje.
    v_palabras := regexp_replace(
      lower(coalesce(p_consulta, '') || ' ' || coalesce(p_terminos, '')),
      '[^a-záéíóúüñ0-9 ]', ' ', 'g'
    );
    v_palabras := array_to_string(
      array(select distinct w from unnest(string_to_array(v_palabras, ' ')) w where length(w) >= 3),
      ' | '
    );

    if v_palabras <> '' then
      begin
        v_amplia := to_tsquery('public.es_sin_acentos', v_palabras);
      exception when others then
        -- Un término raro que igual rompió to_tsquery no puede dejar al bot
        -- sin responder: se sigue al respaldo difuso.
        v_amplia := null;
      end;
    end if;

    if v_amplia is not null and numnode(v_amplia) > 0 then
      select exists (
        select 1 from public.faqs f where f.activa and f.busqueda @@ v_amplia
        union all
        select 1
          from public.fragmentos fr
          join public.documentos d on d.id = fr.documento_id
         where d.activo and d.estado = 'listo' and fr.busqueda @@ v_amplia
      ) into v_hay_resultados;

      if v_hay_resultados then
        v_consulta := v_amplia;
      end if;
    end if;
  end if;

  if not v_hay_resultados then
    -- Respaldo difuso: probablemente el vecino escribió con errores de tipeo o
    -- usó una palabra que no aparece en ningún documento. La similitud trigram
    -- no depende del diccionario del idioma.
    --
    -- Sólo busca en FAQs, a propósito. Un fragmento de PDF son cientos de
    -- palabras: comparar una consulta corta contra eso da ruido. Y una consulta
    -- mal escrita es casi siempre una pregunta frecuente, que es justo lo que
    -- las FAQs cubren.
    perform set_config('pg_trgm.word_similarity_threshold', p_umbral_difuso::text, true);

    return query
      select 'faq'::text,
             f.id,
             f.pregunta,
             f.respuesta,
             null::text,
             null::int,
             (word_similarity(p_consulta, f.pregunta) * p_impulso_faq)::real,
             true
        from public.faqs f
       where f.activa
         and p_consulta <% f.pregunta
       order by word_similarity(p_consulta, f.pregunta) desc
       limit p_limite;
    return;
  end if;

  return query
    with de_faqs as (
      select 'faq'::text                                    as origen,
             f.id,
             f.pregunta                                     as titulo,
             f.respuesta                                    as texto,
             null::text                                     as documento_titulo,
             null::int                                      as pagina,
             (ts_rank(f.busqueda, v_consulta) * p_impulso_faq)::real as rank,
             false                                          as difuso
        from public.faqs f
       where f.activa
         and f.busqueda @@ v_consulta
    ),
    de_fragmentos as (
      select 'fragmento'::text                as origen,
             fr.id,
             fr.titulo_seccion                as titulo,
             fr.texto,
             d.titulo                         as documento_titulo,
             fr.pagina,
             ts_rank(fr.busqueda, v_consulta)::real as rank,
             false                            as difuso
        from public.fragmentos fr
        join public.documentos d on d.id = fr.documento_id
       where d.activo
         and d.estado = 'listo'
         and fr.busqueda @@ v_consulta
    )
    select * from (
      select * from de_faqs
      union all
      select * from de_fragmentos
    ) todo
    order by todo.rank desc
    limit p_limite;
end $$;

comment on function public.buscar_conocimiento(text, text, int, real, real) is
  'Busca en FAQs y fragmentos con ranking unificado, en tres niveles: AND (precisión), OR con términos expandidos (recall) y similitud trigram (tolerancia a errores de tipeo). Las FAQs pesan más porque las escribió un humano del área.';

-- ---------------------------------------------------------------------------
-- Contadores de uso
-- ---------------------------------------------------------------------------
-- El panel necesita saber qué FAQ se usa y cuál no: una FAQ que nunca se usa
-- puede estar mal redactada, o puede ser que nadie pregunte eso.
drop function if exists public.registrar_uso_faq(uuid[]);
create function public.registrar_uso_faq(p_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.faqs
     set veces_usada = veces_usada + 1
   where id = any(p_ids);
$$;

drop function if exists public.registrar_uso_respuesta_fija(uuid);
create function public.registrar_uso_respuesta_fija(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.respuestas_fijas
     set veces_usada = veces_usada + 1
   where id = p_id;
$$;

-- >>>>>>>>>>>>>>>>>>>> 015_umbral_router.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 015 · Umbral de confianza del router de intención
-- ===========================================================================
-- Separado de `umbral_confianza`, que gobierna la síntesis de respuestas. Son
-- dos decisiones distintas con consecuencias distintas:
--
--   umbral_confianza         por debajo, el bot NO responde y registra la
--                            pregunta. El costo de equivocarse es un dato
--                            municipal falso.
--   umbral_confianza_router  por debajo, el bot no arranca un flujo. El costo
--                            de equivocarse es meter al vecino en un
--                            cuestionario que no pidió, y que después tiene
--                            que abandonar para preguntar lo que quería.
--
-- El del router va más alto (0.6 contra 0.55) porque arrancar el flujo
-- equivocado es más molesto que no responder: el vecino queda atrapado
-- contestando preguntas sobre escombros cuando preguntó por Puntos Verdes.
-- ===========================================================================

insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('umbral_confianza_router', '0.6'::jsonb,
   'Confianza mínima para arrancar un flujo transaccional. Por debajo, el bot intenta responder la consulta en vez de imponer un cuestionario. Más alto que umbral_confianza porque equivocarse de flujo es más molesto para el vecino que no responder.',
   'ia')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- Interrupción de flujos por exclusiones
-- ---------------------------------------------------------------------------
-- Las reglas de exclusión corren ANTES del flujo activo: si un vecino escribe
-- «hay olor a gas» mientras carga un pedido de escombros, corresponde
-- derivarlo ya, no terminar de preguntarle cuántas bolsas tiene. Por eso la
-- regla de gas tiene la prioridad más alta de la tabla.
--
-- Es configurable porque tiene un costo: una palabra demasiado genérica
-- cargada desde el panel podría interrumpir flujos legítimos. Si eso llega a
-- molestar, la salida es apagar esta clave y no esperar un deploy.
insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('exclusiones_durante_flujo', 'true'::jsonb,
   'Si las reglas de exclusión pueden interrumpir un flujo en curso. Verdadero por defecto: un olor a gas no puede esperar a que el vecino termine de cargar un pedido de escombros.',
   'negocio')
on conflict (clave) do nothing;

-- >>>>>>>>>>>>>>>>>>>> 016_ingesta.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 016 · Soporte de ingesta para el worker
-- ===========================================================================
-- Dos operaciones que TIENEN que ser atómicas y que PostgREST no puede hacer
-- atómicas desde el cliente, porque cada llamada HTTP es su propia
-- transacción:
--
--   1. Reemplazar los fragmentos de un documento. Son un DELETE y un INSERT.
--      Si se hacen en dos llamadas y la segunda falla, el documento queda con
--      cero fragmentos pero marcado como listo: el buscador deja de encontrarlo
--      y nadie se entera hasta que un vecino pregunta algo que estaba ahí.
--
--   2. Cerrar un trabajo. Decidir entre 'listo', 'error' y volver a 'pendiente'
--      depende de `intentos` contra `max_intentos`, y esa lectura y su escritura
--      tienen que ser la misma transacción para que dos workers no lleguen a
--      conclusiones distintas sobre la misma fila.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Reemplazo atómico de los fragmentos de un documento.
--
-- Recibe los fragmentos como jsonb en vez de como filas porque así entra todo
-- en una sola llamada: 34 fragmentos son 34 inserts por HTTP, y en la primera
-- medición contra Supabase cada ida y vuelta costaba entre 40 y 60 ms.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  -- `create or replace` con la firma cambiada no reemplaza: crea una sobrecarga,
  -- y después `comment on function` falla con «is not unique». Regla del
  -- proyecto: borrar todas las sobrecargas propias antes de crear.
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('reemplazar_fragmentos','terminar_trabajo','encolar_reindexado')
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid and d.deptype = 'e'
       )
  loop
    execute format('drop function if exists %s cascade', r.firma);
  end loop;
end $$;

create function public.reemplazar_fragmentos(
  p_documento_id uuid,
  p_fragmentos   jsonb,
  p_paginas      int  default null,
  p_hash         text default null
) returns int
language plpgsql as $$
declare v_cantidad int;
begin
  if not exists (select 1 from public.documentos where id = p_documento_id) then
    raise exception 'no existe el documento %', p_documento_id;
  end if;

  delete from public.fragmentos where documento_id = p_documento_id;

  insert into public.fragmentos (documento_id, orden, texto, pagina, titulo_seccion, tokens_aprox)
  select p_documento_id,
         (f->>'orden')::int,
         f->>'texto',
         nullif(f->>'pagina','')::int,
         nullif(f->>'titulo_seccion',''),
         nullif(f->>'tokens_aprox','')::int
    from jsonb_array_elements(coalesce(p_fragmentos, '[]'::jsonb)) as f;

  select count(*) into v_cantidad
    from public.fragmentos where documento_id = p_documento_id;

  update public.documentos
     set estado              = case when v_cantidad > 0 then 'listo' else 'error' end,
         error_detalle       = case when v_cantidad > 0 then null
                                    else 'La extracción no produjo ningún fragmento indexable' end,
         cantidad_fragmentos = v_cantidad,
         paginas             = coalesce(p_paginas, paginas),
         hash_sha256         = coalesce(p_hash, hash_sha256)
   where id = p_documento_id;

  return v_cantidad;
end $$;

comment on function public.reemplazar_fragmentos(uuid, jsonb, int, text) is
  'Borra e inserta los fragmentos de un documento en una sola transacción, y actualiza su estado.';

-- ---------------------------------------------------------------------------
-- Cierre de un trabajo, con la política de reintentos en un solo lugar.
--
-- Sin error: queda 'listo'.
-- Con error y con intentos disponibles: vuelve a 'pendiente' para que otro
-- worker lo tome. `tomar_trabajo` ya incrementó `intentos`, así que la cuenta
-- avanza sola y no hay forma de reintentar para siempre.
-- Con error y sin intentos: queda 'error' y lo ve el panel.
--
-- `p_definitivo` corta los reintentos de una vez. Hay errores que no cambian
-- por insistir: un PDF escaneado sin capa de texto, un formato que no se puede
-- leer, un payload mal armado. Reintentarlos tres veces es bajar y procesar el
-- mismo archivo tres veces para llegar al mismo lugar, y mientras tanto el
-- trabajo vuelve a la cola y tapa a los que sí pueden avanzar.
-- ---------------------------------------------------------------------------
create function public.terminar_trabajo(
  p_id         uuid,
  p_error      text    default null,
  p_definitivo boolean default false
) returns public.trabajos
language plpgsql as $$
declare v_fila public.trabajos;
begin
  -- La condición se calcula UNA vez y se usa en las tres columnas. Repetirla
  -- tres veces es como estaba antes, y era una invitación a que una quedara
  -- desincronizada de las otras en el próximo cambio.
  update public.trabajos t
     set estado = case
                    when p_error is null          then 'listo'
                    when p_definitivo             then 'error'
                    when intentos >= max_intentos then 'error'
                    else                               'pendiente'
                  end,
         error_detalle = p_error,
         -- Se libera el dueño sólo si vuelve a la cola. En 'listo' y 'error'
         -- se conserva para poder auditar qué worker lo procesó.
         tomado_por = case when vuelve_a_la_cola then null else tomado_por end,
         tomado_en  = case when vuelve_a_la_cola then null else tomado_en  end,
         finalizado_en = case when vuelve_a_la_cola then null else now() end
    from (select p_error is not null
                 and not p_definitivo
                 and t0.intentos < t0.max_intentos as vuelve_a_la_cola
            from public.trabajos t0 where t0.id = p_id) calculado
   where t.id = p_id
  returning t.* into v_fila;

  if v_fila.id is null then
    raise exception 'no existe el trabajo %', p_id;
  end if;

  return v_fila;
end $$;

comment on function public.terminar_trabajo(uuid, text, boolean) is
  'Cierra un trabajo: listo, error, o de vuelta a pendiente si quedan intentos. p_definitivo corta los reintentos.';

-- ---------------------------------------------------------------------------
-- Encola un reindexado por cada documento activo.
--
-- Un solo trabajo que reindexe los ocho documentos sería un error: si falla el
-- quinto, el reintento vuelve a procesar los cuatro que ya estaban bien, y si
-- agota los intentos se marca en error todo el lote sin distinguir qué falló.
-- ---------------------------------------------------------------------------
create function public.encolar_reindexado(p_creado_por uuid default null)
returns int
language plpgsql as $$
declare v_encolados int;
begin
  with nuevos as (
    insert into public.trabajos (tipo, payload, creado_por, prioridad)
    select 'reindexar_documento',
           jsonb_build_object('documento_id', d.id),
           p_creado_por,
           -- Más abajo en la cola que una subida nueva: el panel espera por la
           -- subida, nadie espera por un reindexado masivo.
           200
      from public.documentos d
     where d.activo
       -- No se duplica un reindexado que ya está esperando para ese documento.
       and not exists (
         select 1 from public.trabajos t
          where t.tipo = 'reindexar_documento'
            and t.estado in ('pendiente','tomado')
            and t.payload->>'documento_id' = d.id::text
       )
    returning 1
  )
  select count(*) into v_encolados from nuevos;

  return v_encolados;
end $$;

comment on function public.encolar_reindexado(uuid) is
  'Encola un reindexado por documento activo, sin duplicar los que ya esperan.';

-- >>>>>>>>>>>>>>>>>>>> 017_cierra_acceso_autenticado.sql <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>> 018_panel.sql <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>> 019_respuestas.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 019 · Lo que necesita la sección de Respuestas del panel
-- ===========================================================================
-- Hoy hay CERO FAQs y CERO respuestas fijas cargadas, y es lo de mayor impacto
-- que puede hacer el área: `buscar_conocimiento` le da a una FAQ el doble de
-- peso que a un fragmento de PDF (p_impulso_faq = 2.0), porque una respuesta
-- escrita por una persona del área ya está redactada para un vecino y alguien
-- la revisó.
--
-- Tres cosas:
--
--   1. Que un operador pueda cargar y un supervisor publicar. Hasta ahora
--      `panel_gestiona` daba `for all` a cualquiera del padrón, así que un
--      operador podía publicar sin revisión algo que le llega a un vecino.
--   2. Poder probar una respuesta fija antes de publicarla. Sus disparadores
--      pueden ser `regex`, y una expresión mal escrita atrapa TODO lo que
--      escriba cualquier vecino.
--   3. Saber qué respuesta fija se usó en cada mensaje, que hoy no se registra.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · Publicar es una acción de supervisor
--
-- El modelo: un operador crea y edita en borrador (`activa = false`), y un
-- supervisor o admin es el único que puede poner `activa = true`. Es la
-- diferencia entre «escribí una respuesta» y «esto ya se lo estamos diciendo a
-- los vecinos».
--
-- Se implementa con dos políticas separadas por operación en vez de una `for
-- all`, porque el chequeo de UPDATE necesita mirar la fila nueva (`with check`)
-- y eso no se puede expresar en una política que también cubre el SELECT.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['faqs','respuestas_fijas']
  loop
    -- `create policy` no tiene `if not exists`, así que hay que borrar TODAS
    -- las que este bloque crea, no sólo la que reemplaza. Es una regla del
    -- proyecto desde la 007 y me la volví a olvidar acá: la segunda pasada del
    -- arnés falló con «policy respuestas_lee already exists».
    execute format('drop policy if exists panel_gestiona    on public.%I', t);
    execute format('drop policy if exists respuestas_lee    on public.%I', t);
    execute format('drop policy if exists respuestas_crea   on public.%I', t);
    execute format('drop policy if exists respuestas_edita  on public.%I', t);
    execute format('drop policy if exists respuestas_borra  on public.%I', t);

    -- Leer: cualquiera del padrón, incluidos los borradores. Hace falta para
    -- que un operador vea lo que dejó a medias.
    execute format($p$
      create policy respuestas_lee on public.%I
        for select to authenticated
        using (public.es_personal_panel())$p$, t);

    -- Crear: cualquiera del padrón, pero SIEMPRE como borrador. Un operador no
    -- puede publicar de una.
    execute format($p$
      create policy respuestas_crea on public.%I
        for insert to authenticated
        with check (
          public.es_personal_panel()
          and (activa = false or public.es_admin_panel())
        )$p$, t);

    -- Editar: se puede tocar el texto siempre; poner `activa = true` sólo si es
    -- supervisor o admin. Un operador que intente publicar recibe un error de
    -- política, no un cambio silencioso.
    execute format($p$
      create policy respuestas_edita on public.%I
        for update to authenticated
        using (public.es_personal_panel())
        with check (
          public.es_personal_panel()
          and (activa = false or public.es_admin_panel())
        )$p$, t);

    -- Borrar: sólo supervisor o admin. Una respuesta borrada se pierde con su
    -- contador de uso, que es justamente el dato que dice si servía.
    execute format($p$
      create policy respuestas_borra on public.%I
        for delete to authenticated
        using (public.es_admin_panel())$p$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2 · Probar una respuesta fija antes de publicarla
--
-- Los disparadores admiten modo `regex`, y ahí está el peligro: una expresión
-- como `.*` atrapa absolutamente todo lo que escriba cualquier vecino, y el bot
-- deja de hacer otra cosa que responder eso. Con `contiene` el riesgo es menor
-- pero existe: un disparador como «a» coincide con casi cualquier mensaje.
--
-- Esta función simula la evaluación contra un texto de prueba SIN publicar nada,
-- y devuelve además cuántos de los últimos mensajes reales habría atrapado. Ese
-- segundo número es el que importa: un disparador que coincide con 200 de los
-- últimos 200 mensajes está mal, sin importar lo razonable que parezca.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as firma
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('probar_disparadores','registrar_uso_respuesta_fija_en_mensaje')
  loop
    execute format('drop function if exists %s cascade', r.firma);
  end loop;
end $$;

-- Se usa `unaccent()`, de la extensión que ya instala la 001 y que usa la
-- configuración de búsqueda `es_sin_acentos`. No hay una función propia de
-- normalización en la base: la del código TypeScript (`normalizar` en
-- src/texto.ts) hace más cosas, pero para comparar disparadores alcanza con
-- bajar a minúsculas y sacar acentos.
create function public.probar_disparadores(
  p_disparadores text[],
  p_modo         text,
  p_texto        text default null
)
returns table (
  coincide_el_texto boolean,
  mensajes_mirados  int,
  mensajes_atrapados int,
  ejemplos          text[]
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_coincide boolean := false;
  v_mirados  int := 0;
  v_atrapados int := 0;
  v_ejemplos text[] := '{}';
  v_d text;
  v_norm text;
begin
  if not public.es_personal_panel() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  if p_modo not in ('exacto','contiene','regex') then
    raise exception 'modo invalido: %', p_modo;
  end if;

  -- ¿Coincide con el texto que escribió quien está probando?
  if p_texto is not null and p_texto <> '' then
    v_norm := lower(unaccent(p_texto));
    foreach v_d in array p_disparadores
    loop
      v_coincide := v_coincide or case p_modo
        when 'exacto'   then v_norm = lower(unaccent(v_d))
        when 'contiene' then position(lower(unaccent(v_d)) in v_norm) > 0
        when 'regex'    then v_norm ~ v_d
      end;
      exit when v_coincide;
    end loop;
  end if;

  -- Y contra los mensajes reales que ya recibió el bot. Es la prueba que
  -- importa: mide el disparador contra lo que la gente escribe de verdad, no
  -- contra lo que uno imagina que va a escribir.
  with ultimos as (
    select texto from public.mensajes
     where direccion = 'entrante' and texto is not null and texto <> ''
     order by creado_en desc
     limit 200
  ), evaluados as (
    select u.texto,
           exists (
             select 1 from unnest(p_disparadores) as d
              where case p_modo
                      when 'exacto'   then lower(unaccent(u.texto)) = lower(unaccent(d))
                      when 'contiene' then position(lower(unaccent(d)) in lower(unaccent(u.texto))) > 0
                      when 'regex'    then lower(unaccent(u.texto)) ~ d
                    end
           ) as atrapado
      from ultimos u
  )
  select count(*)::int,
         count(*) filter (where atrapado)::int,
         coalesce(array_agg(left(texto, 90)) filter (where atrapado), '{}')
    into v_mirados, v_atrapados, v_ejemplos
    from evaluados;

  -- Sólo los primeros cinco ejemplos: la lista es para darse una idea, no para
  -- leerla entera.
  return query select v_coincide, v_mirados, v_atrapados, v_ejemplos[1:5];
end $$;

revoke all on function public.probar_disparadores(text[], text, text) from public, anon;
grant execute on function public.probar_disparadores(text[], text, text) to authenticated, service_role;

comment on function public.probar_disparadores(text[], text, text) is
  'Simula los disparadores de una respuesta fija sin publicarla, y mide cuantos mensajes reales atraparia.';

-- ---------------------------------------------------------------------------
-- 3 · Qué respuesta fija se usó en cada mensaje
--
-- `mensajes.origen_respuesta` ya guarda 'respuesta_fija', pero no CUÁL. Sin eso
-- el único dato de uso es el contador `veces_usada`, que dice cuántas veces se
-- usó pero no en qué conversación ni cuándo — así que no se puede revisar si la
-- respuesta fue apropiada para lo que preguntó el vecino.
--
-- Se agrega la columna con FK y `on delete set null`: si alguien borra la
-- respuesta fija, el mensaje histórico no se pierde ni queda apuntando a nada.
-- ---------------------------------------------------------------------------
alter table public.mensajes
  add column if not exists respuesta_fija_id uuid
    references public.respuestas_fijas(id) on delete set null;

comment on column public.mensajes.respuesta_fija_id is
  'Cual respuesta fija se envio. Null si la respuesta no vino de una.';

create index if not exists mensajes_respuesta_fija_idx
  on public.mensajes (respuesta_fija_id) where respuesta_fija_id is not null;

-- ---------------------------------------------------------------------------
-- 4 · `faqs.prioridad` estaba muerta
--
-- `buscar_conocimiento` ordena por `rank` y no la mira nunca (verificado con
-- grep sobre todo el código). Una columna que el panel muestra como si hiciera
-- algo, y no hace nada, es peor que no tenerla: alguien la va a ajustar
-- esperando un efecto.
--
-- No se borra —hay filas que podrían tenerla cargada en el futuro— pero se
-- documenta con precisión para que el panel no la ofrezca como si sirviera.
-- ---------------------------------------------------------------------------
comment on column public.faqs.prioridad is
  'NO SE USA. buscar_conocimiento ordena por ts_rank y nunca la lee. Se conserva por compatibilidad; el panel no la debe ofrecer como si tuviera efecto.';

comment on column public.faqs.etiquetas is
  'Para filtrar en el panel. NO entra en la busqueda del bot: la columna generada `busqueda` es pregunta + respuesta.';

-- >>>>>>>>>>>>>>>>>>>> 020_amabilidad.sql <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- 020 · Dos mensajes que estaban en el código y uno que faltaba
-- ===========================================================================
-- Salen de probar el bot de verdad:
--
--   1. Después de responder una consulta, Migue cortaba en seco. Falta
--      preguntar si sirvió o si necesita algo más, que es lo que hace que no
--      parezca una máquina expendedora de respuestas.
--
--   2. La despedida estaba escrita en el código («¡De nada! Si necesitás algo
--      más, escribime.», en nucleo/orquestador.ts). Es un mensaje que lee un
--      vecino, así que su lugar es esta tabla y no un literal: el área tiene que
--      poder ajustar el tono sin un deploy.
--
--   3. `reclamo_info_turnos` la LEE el código —reclamoRecoleccion.ts, con
--      `tieneTexto()`— y la fila nunca existió. Al no encontrarla, el bot saltea
--      esa información en silencio. Se crea vacía a propósito: vacía se
--      comporta igual que hoy, y el día que el área escriba los turnos reales
--      empieza a decirlos sin tocar código.
-- ===========================================================================

insert into public.textos_bot (clave, texto, descripcion) values
  ('seguimiento_tras_responder',
   '¿Te sirvió? Si necesitás algo más, escribime.',
   'Se envía DESPUÉS de responder una consulta, como mensaje aparte. Dejalo vacío para que el bot no pregunte nada al final.'),

  ('despedida',
   '¡De nada! Cualquier otra cosa, escribime.',
   'Cuando el vecino agradece o se despide.'),

  ('reclamo_info_turnos',
   '',
   'Turnos y días de recolección, si el área los quiere informar en el reclamo. VACÍO por defecto: así el bot no dice nada. Al escribir algo acá empieza a informarlo.')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- Por qué `seguimiento_tras_responder` puede ir vacío y `bienvenida` no
--
-- El código distingue dos formas de leer un texto:
--   `leerTexto()`   obligatorio. Si no está, devuelve «[falta texto: clave]» y
--                   eso se le envía al vecino.
--   `tieneTexto()`  opcional. Si está vacío, el bot simplemente no lo manda.
--
-- El panel necesita saber cuál es cuál para no dejar vaciar un texto
-- obligatorio. Se agrega una columna en vez de mantener la lista en el código
-- del panel, que se desincronizaría en el primer cambio.
-- ---------------------------------------------------------------------------
alter table public.textos_bot
  add column if not exists opcional boolean not null default false;

comment on column public.textos_bot.opcional is
  'true si el codigo lo lee con tieneTexto() y por lo tanto puede ir vacio. false si lo lee con leerTexto(), donde vaciarlo le enviaria «[falta texto: clave]» al vecino.';

update public.textos_bot set opcional = true
 where clave in ('seguimiento_tras_responder', 'reclamo_info_turnos', 'separa_fuera_de_avenidas');

-- ---------------------------------------------------------------------------
-- El menú deja de llevar su propia lista numerada
--
-- Ahora se envía con OPCIONES de verdad: en Telegram son botones, y si el vecino
-- escribe el número el bot lo entiende. El texto tenía una lista de cuatro ítems
-- escrita a mano, y las opciones son seis: dos listas distintas en el mismo
-- mensaje se contradicen.
--
-- Queda sólo la línea de presentación, que es lo editable. Cuando se sume
-- WhatsApp y su adaptador no pueda mostrar botones, va a ser ese adaptador el
-- que arme la lista numerada a partir de las opciones — no este texto.
--
-- Se actualiza sólo si sigue teniendo la lista vieja: si el área ya lo reescribió
-- no se le pisa el trabajo.
-- ---------------------------------------------------------------------------
update public.textos_bot
   set texto = 'Decime con qué necesitás que te ayude.'
 where clave = 'menu_principal'
   and texto like '%1. Retiro de residuos especiales%';

comment on column public.textos_bot.texto is
  'El mensaje tal como lo lee el vecino. Los marcadores {plazo}, {vencimiento}, {empresa} y {direccion} los reemplaza el bot al enviar.';
