-- ===========================================================================
-- 038 · La presentación, y «Otra consulta» que no preguntaba nada
-- ===========================================================================
-- Las dos salen de leer una conversación real de arranque, que era ésta:
--
--   Migue  Hola, soy Migue Ambiente 🌱 de la Municipalidad de San Miguel de
--          Tucumán.
--          Puedo ayudarte con retiro de residuos especiales, reclamos de
--          recolección, programas ambientales y Puntos Verdes.
--          Contame qué necesitás.
--   Migue  Decime con qué necesitás que te ayude.
--          [Retirar escombros, poda o muebles]
--          [El camión no pasó]
--          [Reciclables y SEPARÁ]
--          [Taller o charla para una institución (EDUCÁ)]
--          [Mural o intervención en un espacio (TRANSFORMÁ)]
--          [Otra consulta]
--   Vecino (toca «Otra consulta»)
--   Migue  No tengo esa información con la certeza suficiente para
--          respondértela. Ya la registré para que el equipo de Ambiente la
--          revise.
--
-- 1 · LA PRESENTACIÓN DICE TRES VECES LO MISMO. La bienvenida enumera en prosa
--     las cuatro cosas que Migue hace, y abajo las mismas cosas vuelven como
--     seis opciones; y encima se le pregunta dos veces qué necesita («Contame
--     qué necesitás» y «Decime con qué necesitás que te ayude»). Enumerar en
--     prosa tenía sentido cuando el menú era un texto numerado; desde la 020 el
--     menú se manda con opciones de verdad, así que la prosa quedó de más.
--
--     Se resuelve repartiendo: la bienvenida PRESENTA (una línea) y el menú
--     PREGUNTA (una vez), avisando además que puede escribir directamente —lo
--     que decía el texto de la 008 y se perdió al quitarle la lista numerada—.
--     Las etiquetas se acortaron en `opciones.ts`, que es donde viven porque
--     tienen que corresponderse con los ids de intención.
--
-- 2 · «OTRA CONSULTA» CONTESTABA UNA DISCULPA. El toque del botón deja el id
--     interno como texto del mensaje, así que el bot buscaba en el corpus la
--     frase «consulta_libre», no encontraba nada y se disculpaba — sin que el
--     vecino hubiera preguntado nada todavía. Además pagaba una llamada al
--     modelo y dejaba una fila en `sin_respuesta` con la pregunta
--     «consulta_libre»: el área veía como hueco de conocimiento algo que ningún
--     vecino preguntó nunca.
--
--     El arreglo del camino está en `orquestador.ts` (corta antes de la cadena
--     de conocimiento e invita a escribir). Acá va el texto de esa invitación,
--     que es lo que lee el vecino y por lo tanto tiene que poder editarse sin
--     un deploy.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · El texto nuevo: la invitación a escribir la consulta
--
-- OBLIGATORIO (opcional = false) y por una razón concreta: el bot corta el
-- camino de la cadena de conocimiento y este mensaje es lo ÚNICO que manda en
-- ese turno. Vaciarlo dejaría al vecino sin respuesta después de tocar un botón.
-- Los ejemplos que enumera son los que la bienvenida dejó de enumerar: acá
-- sirven —le dicen qué clase de cosa puede preguntar— y allá sobraban.
--
-- El formato de estas tuplas lo parsea catalogo.claves.test.ts: cada una abre
-- su propia línea con ('clave', — no lo cambies (ver 033).
-- ---------------------------------------------------------------------------
insert into public.textos_bot (clave, texto, descripcion, opcional) values
  ('consulta_invitacion',
   'Dale, escribime tu consulta y te busco la información. Puede ser sobre horarios de recolección, Puntos Verdes, reciclado o cualquier otro tema de Ambiente.',
   'Cuando el vecino elige «Otra consulta» en el menú todavía no preguntó nada: esto lo invita a escribir y el bot espera. La respuesta se la da recién con el mensaje siguiente.',
   false)
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- 2 · La bienvenida PRESENTA y el menú PREGUNTA
--
-- Los dos updates van condicionados al texto EXACTO que sembró la migración que
-- los puso —la 008 y la 020—, byte a byte. Es la regla de la 009, la 011, la
-- 036 y la 037: si el área ya reescribió el mensaje desde el panel, esta
-- migración no le pisa la redacción.
-- ---------------------------------------------------------------------------
update public.textos_bot
   set texto = E'Hola, soy Migue Ambiente \U0001F331, de la Municipalidad de San Miguel de Tucumán.',
       descripcion = 'Primer mensaje, y sólo la presentación: el menú va detrás y es el que pregunta. Enumerar acá lo que Migue hace repetía las opciones que el vecino ve abajo.'
 where clave = 'bienvenida'
   and texto = E'Hola, soy Migue Ambiente \U0001F331 de la Municipalidad de San Miguel de Tucumán.\n\nPuedo ayudarte con retiro de residuos especiales, reclamos de recolección, programas ambientales y Puntos Verdes.\n\nContame qué necesitás.';

update public.textos_bot
   set texto = '¿Con qué necesitás que te ayude? Elegí una de estas opciones, o escribime directamente lo que necesitás.',
       descripcion = 'Acompaña al menú de opciones. Es la ÚNICA pregunta de la presentación, y avisa que también puede escribir sin elegir nada. Las opciones no salen de acá: viven en el código porque cada una es una intención del router.'
 where clave = 'menu_principal'
   and texto = 'Decime con qué necesitás que te ayude.';
