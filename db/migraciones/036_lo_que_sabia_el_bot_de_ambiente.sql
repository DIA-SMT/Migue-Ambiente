-- ===========================================================================
-- 036 · Datos que sabía el bot de Ambiente y nosotros no
-- ===========================================================================
-- El área de Ambiente había hecho su propio bot, en un solo archivo de Node
-- (Baileys + Ollama, sin base de datos). No sirve como sistema —los datos de
-- vecinos terminaban en JSON planos y en un repositorio de GitHub—, pero
-- ADENTRO tiene conocimiento operativo real que nosotros nunca tuvimos: lo
-- escribió gente que atiende el servicio todos los días.
--
-- Esta migración rescata SÓLO datos. Ni una capacidad nueva, ni un cambio de
-- comportamiento: cinco huecos que estaban esperando que alguien los llenara.
--
--   1. `feriados` estaba en '[]' desde la 009. El plazo que Migue promete
--      atravesaba Carnaval y Semana Santa como si fueran días hábiles.
--   2. Zona Norte cargaba los días equivocados.
--   3. La regla del SAT derivaba sin decir a dónde.
--   4. `reclamo_info_turnos` esperaba una URL desde la 020.
--   5. No teníamos los otros canales del municipio.
--
-- TODAS las actualizaciones van condicionadas al valor sembrado, como en la
-- 011: si el área ya lo editó desde el panel, esta migración no le pisa nada.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · Feriados 2026
--
-- `sla.ts` los usa para correr el vencimiento y `configSla()` los lee de acá.
-- La clave existe desde la 009 pero se sembró vacía, así que hasta hoy un
-- pedido tomado el jueves de Semana Santa vencía el lunes como si el municipio
-- hubiera trabajado el viernes.
--
-- LA LISTA VIENE DEL BOT DE AMBIENTE, CON DOS CORRECCIONES:
--
--   · Se QUITAN 2026-04-06 a 2026-04-10. La lista original los traía como
--     feriados y no lo son: Pascua 2026 cae el domingo 5 de abril, así que
--     Semana Santa termina el viernes 3. Son cinco días hábiles comunes, y
--     dárselos por feriados le agrega una semana al plazo de cada vecino.
--     PENDIENTE: preguntarle a Ambiente si no quisieron anotar un receso
--     municipal en esa semana. Si existe, se vuelven a cargar desde el panel.
--
--   · Se AGREGA 2026-09-24, Batalla de Tucumán. Es feriado provincial y la
--     lista original no lo tenía, así que el bot de ellos prometía retiros para
--     un día en que la ciudad no trabaja.
--
-- PENDIENTES DE CONFIRMAR contra el decreto del Poder Ejecutivo, que sale año a
-- año y todavía no verificamos:
--   · 2026-03-23 — figura como puente turístico. Los puentes no están en la
--     ley: los fija un decreto.
--   · 2026-11-20 — Soberanía Nacional cae viernes. Es feriado trasladable, así
--     que podría correrse al lunes 23.
--
-- Mientras tanto la lista es mejor que estar vacía, y se corrige desde
-- Reglas → Plazos sin deploy.
-- ---------------------------------------------------------------------------
update public.configuracion
   set valor = '[
         "2026-01-01",
         "2026-02-16",
         "2026-02-17",
         "2026-03-23",
         "2026-03-24",
         "2026-04-02",
         "2026-04-03",
         "2026-05-01",
         "2026-05-25",
         "2026-06-15",
         "2026-06-20",
         "2026-07-09",
         "2026-08-17",
         "2026-09-24",
         "2026-10-12",
         "2026-11-20",
         "2026-12-08",
         "2026-12-25"
       ]'::jsonb,
       descripcion = 'Feriados en formato YYYY-MM-DD que corren el vencimiento del plazo. Cargados para 2026: nacionales más la Batalla de Tucumán (24/9), que es provincial. PENDIENTE de verificar contra el decreto: 2026-03-23 (puente turístico) y 2026-11-20 (trasladable, podría correrse al lunes 23). HAY QUE RECARGARLOS CADA AÑO.'
 where clave = 'feriados'
   and valor = '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- 2 · Zona Norte carga lunes, MIÉRCOLES y viernes
--
-- La 008 sembró Norte con «lunes, martes, viernes», tomándolo del Anexo de
-- Datos de la spec. El bot de Ambiente —que es el que viene funcionando contra
-- el operativo real— usa lunes, miércoles y viernes.
--
-- Lo que inclina la balanza no es cuál de los dos documentos gana, sino que con
-- «martes» el martes queda en las DOS zonas y el miércoles en ninguna. Con
-- miércoles el esquema alterna sin huecos y coincide exactamente con Zona Sur,
-- donde los dos documentos ya decían lo mismo (martes, jueves, sábado).
--
-- Se toma el dato del operativo. Queda anotado igual para que Ambiente lo
-- confirme: si la spec tenía razón, se revierte desde Reglas → Puntos y Zonas.
-- ---------------------------------------------------------------------------
update public.zonas_recoleccion
   set dias = array['lunes','miercoles','viernes'],
       observaciones = 'Los residuos se sacan a las 14:30 hs del día que corresponde, y sólo después de la confirmación del retiro. Días corregidos según el operativo real (la spec decía martes; con martes el miércoles quedaba sin zona).'
 where nombre = 'Zona Norte'
   and dias = array['lunes','martes','viernes'];

-- El texto de confirmación del retiro repite los días escritos a mano, así que
-- si no se corrige acá el vecino recibe un dato y el catálogo dice otro.
-- `replace` y no un texto nuevo: así no importa si la 011 ya lo reescribió con
-- marcadores, y cualquier otra edición del área se conserva.
update public.textos_bot
   set texto = replace(texto,
                       'Zona Norte: recolección Lun, Mar, Vie.',
                       'Zona Norte: recolección Lun, Mié, Vie.')
 where clave = 'retiro_confirmacion'
   and texto like '%Zona Norte: recolección Lun, Mar, Vie.%';

-- ---------------------------------------------------------------------------
-- 3 · La derivación al SAT dice a dónde llamar
--
-- La regla existe desde la 008 y cierra la conversación con «corresponde al
-- SAT». Es correcto y es inútil: el vecino queda con el problema y sin el
-- teléfono. El bot de Ambiente sí daba los datos, y son los oficiales.
--
-- El 0800 es lo que importa: atiende 24 hs, y las pérdidas de agua no esperan
-- al horario de oficina.
-- ---------------------------------------------------------------------------
update public.reglas_exclusion
   set respuesta = E'Te informamos que ese tipo de reclamo no corresponde a la competencia municipal. Corresponde al SAT (Aguas del Tucumán).\n\n📞 0800-444-1726 — línea gratuita, las 24 hs\n🌐 https://www.sat.com.ar'
 where nombre = 'Agua y cloacas (SAT)'
   and respuesta = 'Te informamos que ese tipo de reclamo no corresponde a la competencia municipal. Corresponde al SAT (Aguas del Tucumán).';

-- ---------------------------------------------------------------------------
-- 4 · El mapa de recorridos, que esperábamos desde la 020
--
-- `reclamo_info_turnos` se creó vacía a propósito porque Ambiente no nos había
-- pasado la URL, y `reclamoRecoleccion.ts` la lee con `tieneTexto()`: vacía, el
-- bot saltea el mensaje. El bot de ellos la tenía.
--
-- Va como segundo mensaje del diagnóstico: el vecino que reclama porque no pasó
-- el camión muchas veces está mirando el día equivocado, y con el mapa se
-- responde solo sin esperar las 72 hs.
-- ---------------------------------------------------------------------------
update public.textos_bot
   set texto = E'Mientras tanto podés confirmar qué día y en qué turno le toca a tu domicilio:\nhttps://smtendatos.gob.ar/mapa-interactivo-de-recoleccion-de-residuos-por-turno/',
       descripcion = 'Enlace al mapa interactivo de recolección por turno. Se envía como segundo mensaje del diagnóstico del reclamo. Sigue siendo opcional: vaciarlo desde el panel apaga el mensaje.'
 where clave = 'reclamo_info_turnos'
   and coalesce(texto, '') = '';

-- ---------------------------------------------------------------------------
-- 5 · Los otros canales del municipio
--
-- Dato nuevo: no lo teníamos en ninguna tabla. El bot de Ambiente cerraba todo
-- lo que no era suyo ofreciendo la App Ciudad Digital y el teléfono de Atención
-- Ciudadana.
--
-- Va como RESPUESTA FIJA y no como texto del bot por dos razones. Una: un
-- número de teléfono y una URL son exactamente el caso de «redacción que el
-- modelo no puede parafrasear», que es para lo que existe esta tabla. Dos: NO
-- toca la política de derivación que el área definió en la 026 —lo que no es de
-- Ambiente sigue yendo a Migue—; esto contesta al vecino que pregunta
-- puntualmente por esos canales.
--
-- `where not exists` en lugar de `on conflict`: `respuestas_fijas.nombre` no
-- tiene índice único, y no se lo agrego porque los operadores crean fijas desde
-- el resolver de «sin responder» y nada les impide repetir un nombre.
--
-- Prioridad 80: menor gana, y esto es informativo. Cualquier fija que el área
-- cargue con el default 50 se evalúa antes.
-- ---------------------------------------------------------------------------
insert into public.respuestas_fijas (nombre, disparadores, modo, respuesta, prioridad, notas)
select
  'Otros canales del municipio',
  array['ciudad digital','atencion ciudadana','app del municipio','app de la muni'],
  'contiene',
  E'Para trámites y reclamos de otras áreas del municipio tenés dos canales:\n\n📱 App Ciudad Digital\nhttps://ciudaddigital.smt.gob.ar/#/registro\n\n☎️ Atención Ciudadana\n381 223-0573',
  80,
  'Datos rescatados del bot propio de la Secretaría de Ambiente. No reemplaza la derivación a Migue: contesta al vecino que pregunta por estos canales en particular.'
where not exists (
  select 1 from public.respuestas_fijas where nombre = 'Otros canales del municipio'
);
