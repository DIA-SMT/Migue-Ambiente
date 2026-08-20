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
