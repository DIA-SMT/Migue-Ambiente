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
