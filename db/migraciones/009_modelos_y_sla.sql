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
