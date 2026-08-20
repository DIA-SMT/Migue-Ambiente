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
