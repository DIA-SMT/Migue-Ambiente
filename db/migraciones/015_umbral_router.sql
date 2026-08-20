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
