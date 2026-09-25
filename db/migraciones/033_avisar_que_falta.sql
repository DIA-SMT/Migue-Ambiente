-- ---------------------------------------------------------------------------
-- 033 · El reclamo avisa qué quedó sin cargar
--
-- EL PROBLEMA. `reclamo_diagnostico` promete tres cosas —dirección, foto y
-- desde cuándo— y el flujo sólo frena por la dirección. Eso está bien: la spec
-- dice que la foto es «opcional pero deseable», y exigirla dejaría afuera al
-- vecino que ya guardó la bolsa.
--
-- Lo que estaba mal es que el vecino mandaba la dirección y recibía «Reclamo
-- generado» a secas, idéntico a si hubiera mandado las tres cosas. Se iba
-- creyendo que su reclamo tenía la foto.
--
-- Ahora el reclamo se registra igual y, en un mensaje aparte, se le dice qué no
-- quedó cargado.
--
-- POR QUÉ EL TEXTO NO INVITA A MANDARLO. Creado el ticket, el flujo se cierra y
-- no queda ningún paso esperando. Un «mandámelo ahora» haría que el vecino le
-- mande la foto a un flujo que ya no existe. Prometer un turno que no existe es
-- la misma falla, del otro lado.
--
-- Idempotente. El texto se siembra con `do nothing` para no pisar nunca una
-- redacción que el área haya editado; la descripción y el flag `opcional` sí se
-- actualizan, porque son documentación nuestra.
-- ---------------------------------------------------------------------------

-- OJO CON LA FORMA: cada tupla abre en su propia línea con ('clave',. Es lo que
-- parsea `catalogo.claves.test.ts` para saber qué claves existen en producción,
-- y una tupla pegada al `values` la vuelve invisible para esa prueba.

insert into public.textos_bot (clave, texto, descripcion, opcional) values
  ('pedido_pendientes',
   'Quedó registrado sin {faltante}.',
   'Va después de la confirmación del reclamo, como mensaje aparte, cuando quedó algo sin cargar. NO invita a mandarlo: una vez creado el ticket el flujo se cierra y no hay ningún paso que pueda recibirlo. Vaciarlo hace que el reclamo cierre sin avisar nada, que es como venía antes.',
   true),

  ('dato_foto_reclamo',
   'una foto de la basura sin recolectar',
   'Cómo se nombra la foto cuando el reclamo se registró sin ella. Es un sustantivo y no una pregunta, porque se usa dentro de otra oración.',
   false),

  ('dato_dias',
   'desde cuándo no pasa el camión',
   'Cómo se nombra el tiempo sin servicio cuando el reclamo se registró sin ese dato. Es un sustantivo y no una pregunta, porque se usa dentro de otra oración.',
   false)
on conflict (clave) do update
  set descripcion = excluded.descripcion,
      opcional = excluded.opcional;

-- ---------------------------------------------------------------------------
-- Limpieza de un intento anterior
-- ---------------------------------------------------------------------------
-- Una versión previa de esta migración sembró 24 claves para un mecanismo mucho
-- más grande —con un turno de gracia para sumar datos después— que se dio de
-- baja. Las que ese mecanismo usaba y éste no quedaron en la base sin que
-- ningún archivo las lea: el panel las ofrece para editar, confirma «guardado»
-- y el vecino nunca ve el cambio.
--
-- Es el mismo control roto que tuvo `separa_fuera_de_avenidas` durante meses, y
-- hay un test que lo vigila. Se borran las que sobran.
--
-- Se borran SÓLO si nadie las editó: `actualizado_por is null` distingue una
-- fila sembrada por una migración de una que alguien miró y cambió. Si el área
-- llegó a tocar alguna, queda, y aparece en el test para que decidamos a mano.

delete from public.textos_bot
 where clave in (
   'pedido_falta', 'pedido_tambien', 'pendientes_sumado', 'pendientes_cerrado',
   'flujo_sin_avance',
   'dato_direccion', 'dato_foto_retiro', 'dato_foto_zona', 'dato_foto_reciclables',
   'dato_tipo', 'dato_cantidad', 'dato_institucion', 'dato_responsable',
   'dato_alumnos', 'dato_nombre', 'dato_telefono', 'dato_materiales', 'dato_franja',
   'educa_confirmacion', 'transforma_confirmacion', 'separa_confirmacion'
 )
   and actualizado_por is null;

-- ---------------------------------------------------------------------------
-- Corrección del texto que sembró el intento anterior
-- ---------------------------------------------------------------------------
-- El `on conflict do update` de arriba NO toca `texto`, a propósito: nunca se
-- pisa una redacción que el área haya escrito. Pero eso deja un hueco cuando la
-- fila la sembró una migración nuestra con un texto que después resultó malo,
-- que es justo lo que pasó acá: el intento anterior dejó «…Si lo tenés a mano,
-- mandámelo ahora y lo sumo al pedido», que promete un turno que en esta
-- versión no existe. El vecino mandaría la foto a un flujo ya cerrado.
--
-- Se corrige con un update GUARDADO por el texto exacto que sembramos: si el
-- área lo reescribió, no coincide y se respeta lo suyo.

update public.textos_bot
   set texto = 'Quedó registrado sin {faltante}.'
 where clave = 'pedido_pendientes'
   and texto = 'Quedó pendiente: {faltante}. Si lo tenés a mano, mandámelo ahora y lo sumo al pedido.';

-- ---------------------------------------------------------------------------
-- La confirmación del reclamo nombra la dirección
-- ---------------------------------------------------------------------------
-- El eco es el único control de calidad que tiene el vecino: leer «Reclamo
-- generado para lavaye 500» es la única forma de darse cuenta de que el bot
-- entendió mal antes de que salga una cuadrilla. El flujo ya pasaba
-- `{direccion}` a interpolar y el marcador ya estaba declarado para esta clave;
-- lo único que faltaba era usarlo en el texto.
--
-- Va como update GUARDADO por el texto actual: si el área ya lo reescribió, se
-- respeta. La base guarda el texto; el código guarda qué se hace con él.

update public.textos_bot
   set texto = 'Reclamo generado para {direccion}. Verificaremos el GPS del interno. Si hubo una falla, {empresa} tiene {plazo} para normalizar el servicio.'
 where clave = 'reclamo_confirmacion'
   and texto = 'Reclamo generado. Verificaremos el GPS del interno. Si hubo una falla, {empresa} tiene {plazo} para normalizar el servicio.';
