-- ===========================================================================
-- 032 · Quién es Migue y cómo habla, editable desde el panel
-- ===========================================================================
-- La regla del proyecto dice que nada de lo que el vecino recibe se escribe en
-- el código. La identidad del bot era la excepción: vivía clavada en dos
-- prompts del dominio, así que cambiarle el tono o el nombre del área requería
-- un deploy.
--
-- Y estaba MAL. Los dos prompts decían «Dirección de Ambiente». Los Planes
-- Rectores del propio municipio, que son los documentos que el bot tiene
-- indexados, dicen «Secretaría de Ambiente y Desarrollo Sustentable» cuatro
-- veces y «Dirección de Ambiente» ninguna. Migue se presentaba con un área que
-- no existe con ese nombre.
--
-- QUÉ SE HACE EDITABLE Y QUÉ NO, que es la decisión importante.
--
-- Editable: el nombre del área y el estilo de redacción. Son del área, cambian
-- con el tiempo y no pueden romper nada — lo peor que pasa si alguien vacía
-- `estilo_respuesta` es que Migue conteste más seco, porque el código cae a un
-- estilo por defecto.
--
-- NO editable, y a propósito: la regla de responder únicamente con lo que está
-- en el contexto, y el formato JSON de la respuesta. La primera es lo que
-- impide que Migue invente un horario de recolección; el segundo es el contrato
-- con el parseo, y romperlo deja al bot sin poder contestar nada. Las dos
-- siguen en `responder.ts`, donde hace falta un deploy para tocarlas.
--
-- Es la misma división que ya tiene el panel en Reglas: hay controles marcados
-- «cambia lo que recibe el vecino» y otros que no. Acá el corte es más duro
-- porque del otro lado hay un modelo de lenguaje.
-- ===========================================================================

insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('nombre_area',
   '"Secretaría de Ambiente y Desarrollo Sustentable"'::jsonb,
   'Cómo se presenta Migue y cómo lo nombran los mensajes de derivación. Verificado contra los Planes Rectores del municipio.',
   'negocio'),

  ('estilo_respuesta',
   -- `to_jsonb` y no `::jsonb`: castear un texto plano a jsonb falla, porque un
   -- string JSON necesita las comillas dobles. Con `to_jsonb` las pone Postgres.
   to_jsonb('- Español rioplatense, voseo. Tratamiento cordial y directo.' || chr(10) ||
    '- Breve: dos o tres frases salvo que la pregunta pida un listado.' || chr(10) ||
    '- Texto plano. Sin asteriscos, sin markdown, sin encabezados.' || chr(10) ||
    '- Dá el dato primero. Si hace falta aclarar algo, después.' || chr(10) ||
    '- No cites números de fragmento ni nombres de archivo: al vecino no le sirven.' || chr(10) ||
    '- Si el contexto tiene direcciones u horarios, transcribilos exactos.'),
   'Cómo redacta Migue. Una instrucción por línea. Vaciarlo lo deja con el estilo por defecto del código, no lo rompe. No cambia QUÉ contesta: eso lo deciden las respuestas, las FAQs y los documentos.',
   'negocio')
on conflict (clave) do nothing;
