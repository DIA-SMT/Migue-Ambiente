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
