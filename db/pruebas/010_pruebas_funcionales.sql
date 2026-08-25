-- ===========================================================================
-- Pruebas funcionales del esquema. SOLO para la base desechable.
-- Cada bloque falla ruidosamente si el comportamiento no es el esperado.
-- ===========================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Limpieza previa: borra sólo los artefactos que crean estas pruebas, para que
-- el archivo se pueda correr dos veces seguidas y dé el mismo resultado.
-- NO toca las semillas: el bloque A justamente verifica que no se dupliquen.
-- ---------------------------------------------------------------------------
delete from public.trabajos;
delete from public.sin_respuesta;
delete from public.mensajes;
delete from public.conversaciones where canal_usuario_id = '123456';
delete from public.faqs where pregunta in (
  '¿Dónde puedo llevar mis neumáticos?',
  '¿Cómo separo los residuos reciclables?');
delete from public.documentos where ruta_storage in ('docs/prueba-separa.pdf','docs/prueba-controla.pdf');
delete from public.faqs where pregunta like '%recorrido del camión%';

-- ---------------------------------------------------------------------------
-- A · Las semillas no se duplicaron tras varias corridas
-- ---------------------------------------------------------------------------
\echo '== A · semillas sin duplicados =='
select 'configuracion'     as tabla, count(*) from public.configuracion
union all select 'textos_bot',        count(*) from public.textos_bot
union all select 'limites_volumen',   count(*) from public.limites_volumen
union all select 'zonas_recoleccion', count(*) from public.zonas_recoleccion
union all select 'puntos_verdes',     count(*) from public.puntos_verdes
union all select 'reglas_exclusion',  count(*) from public.reglas_exclusion
order by 1;

do $$
declare n int;
begin
  select count(*) into n from public.puntos_verdes;
  if n <> 3 then raise exception 'puntos_verdes deberia tener 3, tiene %', n; end if;
  select count(*) into n from public.reglas_exclusion;
  if n <> 7 then raise exception 'reglas_exclusion deberia tener 7, tiene %', n; end if;
end $$;
\echo '   OK: sin duplicados'

-- ---------------------------------------------------------------------------
-- B · Búsqueda de texto en español SIN acentos
-- El caso real: el vecino escribe sin tildes y con errores.
-- ---------------------------------------------------------------------------
\echo ''
\echo '== B · busqueda insensible a acentos =='

insert into public.documentos (titulo, nombre_archivo, formato, ruta_storage, bytes, estado)
values ('Programa SEPARA', 'separa.pdf', 'pdf', 'docs/prueba-separa.pdf', 1000, 'listo')
on conflict (ruta_storage) do nothing;

insert into public.fragmentos (documento_id, orden, texto, titulo_seccion)
select d.id, 1,
       'La recolección diferenciada de residuos sólidos urbanos se realiza los miércoles y sábados de 09 a 12 hs dentro de las cuatro avenidas. Los reciclables deben estar limpios y secos.',
       'Recolección diferenciada'
  from public.documentos d where d.ruta_storage = 'docs/prueba-separa.pdf'
on conflict (documento_id, orden) do nothing;

-- Consulta escrita SIN tildes, como escribe la gente en el chat
select f.orden,
       ts_rank(f.busqueda, websearch_to_tsquery('public.es_sin_acentos', 'recoleccion diferenciada miercoles')) as rank,
       left(f.texto, 60) as fragmento
  from public.fragmentos f
 where f.busqueda @@ websearch_to_tsquery('public.es_sin_acentos', 'recoleccion diferenciada miercoles');

do $$
declare n int;
begin
  -- "recoleccion" sin tilde debe encontrar "recolección" con tilde
  select count(*) into n from public.fragmentos
   where busqueda @@ websearch_to_tsquery('public.es_sin_acentos', 'recoleccion diferenciada miercoles');
  if n < 1 then raise exception 'FTS sin acentos no encontro el fragmento'; end if;

  -- y el stemming en español debe unir singular/plural
  select count(*) into n from public.fragmentos
   where busqueda @@ websearch_to_tsquery('public.es_sin_acentos', 'reciclable');
  if n < 1 then raise exception 'el stemming espanol no unio reciclable/reciclables'; end if;
end $$;
\echo '   OK: acentos y stemming funcionan'

-- ---------------------------------------------------------------------------
-- C · Ranking de FAQs: la pregunta pesa mas que la respuesta (setweight)
-- ---------------------------------------------------------------------------
\echo ''
\echo '== C · ranking de FAQs por setweight =='

insert into public.faqs (pregunta, respuesta, etiquetas) values
  ('¿Dónde puedo llevar mis neumáticos?',
   'Podés dejarlos en cualquier Punto Verde de contenedor, que funcionan las 24 hs.',
   array['neumaticos','puntos-verdes']),
  ('¿Cómo separo los residuos reciclables?',
   'Separalos limpios y secos. Si tenés neumáticos, esos van aparte a un Punto Verde.',
   array['separa'])
on conflict do nothing;

-- La FAQ cuya PREGUNTA habla de neumáticos debe rankear primero, aunque la
-- otra también los mencione en la respuesta.
select left(pregunta, 45) as pregunta,
       round(ts_rank(busqueda, websearch_to_tsquery('public.es_sin_acentos','neumaticos'))::numeric, 5) as rank
  from public.faqs
 where busqueda @@ websearch_to_tsquery('public.es_sin_acentos','neumaticos')
 order by rank desc;

do $$
declare primera text;
begin
  select pregunta into primera from public.faqs
   where busqueda @@ websearch_to_tsquery('public.es_sin_acentos','neumaticos')
   order by ts_rank(busqueda, websearch_to_tsquery('public.es_sin_acentos','neumaticos')) desc
   limit 1;
  if primera not like '%neum%tico%' then
    raise exception 'el setweight no priorizo la pregunta; gano: %', primera;
  end if;
end $$;
\echo '   OK: la pregunta rankea por encima de la respuesta'

-- ---------------------------------------------------------------------------
-- D · Similitud difusa para errores de tipeo
-- ---------------------------------------------------------------------------
\echo ''
\echo '== D · tolerancia a errores de tipeo (trigram) =='
-- Este bloque trae su propio fixture a proposito. El umbral difuso de
-- `buscar_conocimiento` se calibro contra esta FAQ, y si el test dependiera de
-- las FAQs que insertan otros bloques, la calibracion quedaria atada al orden
-- del archivo: la primera version de este bloque medio 0.261 contra una FAQ
-- distinta y parecia que el umbral estaba mal puesto.
insert into public.faqs (pregunta, respuesta, etiquetas) values
  ('¿Cómo verifico el recorrido del camión?',
   'Podés consultar el recorrido en la web del municipio.',
   array['recoleccion'])
on conflict do nothing;

do $$
declare
  v_umbral   real := 0.35;   -- el mismo default que usa buscar_conocimiento
  v_correcta real;
  v_ruido    real;
  v_pregunta text;
begin
  -- La consulta tiene dos palabras mal escritas: «recoridro» y «camoin».
  select pregunta, word_similarity('recoridro del camoin', pregunta)
    into v_pregunta, v_correcta
    from public.faqs
   where activa
   order by word_similarity('recoridro del camoin', pregunta) desc
   limit 1;

  if v_pregunta not ilike '%recorrido del camión%' then
    raise exception 'con el tipeo, la FAQ mejor rankeada fue: %', v_pregunta;
  end if;

  if v_correcta < v_umbral then
    raise exception 'la coincidencia correcta da % y el umbral es %', v_correcta, v_umbral;
  end if;

  -- El ruido tiene que quedar por debajo del umbral. Se mide contra el umbral y
  -- no contra la correcta: lo que importa es que el umbral SEPARE.
  select coalesce(max(word_similarity('recoridro del camoin', pregunta)), 0)
    into v_ruido
    from public.faqs
   where activa and pregunta not ilike '%recorrido del camión%';

  if v_ruido >= v_umbral then
    raise exception 'una FAQ sin relacion da % y pasa el umbral %', v_ruido, v_umbral;
  end if;

  -- `similarity` es lo que NO sirve acá, y conviene que el test lo demuestre en
  -- vez de dejarlo escrito en un comentario: penaliza que la pregunta sea mas
  -- larga que la consulta, y la coincidencia correcta queda al borde del umbral.
  if similarity('recoridro del camoin', v_pregunta) >= v_correcta then
    raise exception 'similarity (%) ya no es peor que word_similarity (%): revisar la eleccion',
      similarity('recoridro del camoin', v_pregunta), v_correcta;
  end if;

  -- El margen queda a la vista: si un cambio futuro lo achica, se ve en la
  -- salida antes de que el test empiece a fallar de forma intermitente.
  raise notice 'umbral difuso: correcta %, ruido %, umbral % (similarity daria %)',
    round(v_correcta::numeric, 3), round(v_ruido::numeric, 3), v_umbral,
    round(similarity('recoridro del camoin', v_pregunta)::numeric, 3);
end $$;
\echo '   OK: el tipeo encuentra la FAQ correcta y el umbral la separa del ruido'

-- ---------------------------------------------------------------------------
-- E · Cola de trabajos: toma atomica y recuperacion de colgados
-- ---------------------------------------------------------------------------
\echo ''
\echo '== E · cola de trabajos =='

insert into public.trabajos (tipo, payload, prioridad) values
  ('ingestar_documento', '{"documento_id":"a"}', 10),
  ('ingestar_documento', '{"documento_id":"b"}', 50);

select tipo, payload->>'documento_id' as doc, estado, intentos, tomado_por
  from public.tomar_trabajo('worker-prueba-1');

do $$
declare v_doc text; v_pend int;
begin
  -- debe haber tomado el de prioridad 10 (menor gana)
  select payload->>'documento_id' into v_doc from public.trabajos
   where estado = 'tomado' and tomado_por = 'worker-prueba-1';
  if v_doc <> 'a' then raise exception 'tomo el trabajo equivocado: % (esperaba a)', v_doc; end if;

  -- un segundo worker debe llevarse el OTRO, no el mismo
  perform public.tomar_trabajo('worker-prueba-2');
  select count(*) into v_pend from public.trabajos where estado = 'pendiente';
  if v_pend <> 0 then raise exception 'quedaron % pendientes, esperaba 0', v_pend; end if;

  if (select count(distinct tomado_por) from public.trabajos where estado='tomado') <> 2 then
    raise exception 'los dos workers tomaron el mismo trabajo';
  end if;
end $$;
\echo '   OK: toma atomica, sin colisiones, respeta prioridad'

-- recuperacion de trabajos colgados
update public.trabajos set tomado_en = now() - interval '1 hour' where estado = 'tomado';
select public.recuperar_trabajos_colgados(15) as trabajos_recuperados;

do $$
declare n int;
begin
  select count(*) into n from public.trabajos where estado = 'pendiente';
  if n <> 2 then raise exception 'esperaba 2 devueltos a la cola, hay %', n; end if;
end $$;
\echo '   OK: los trabajos colgados vuelven a la cola'

-- ---------------------------------------------------------------------------
-- F · Trigger de actividad en conversaciones
-- ---------------------------------------------------------------------------
\echo ''
\echo '== F · contador de mensajes por trigger =='

insert into public.conversaciones (canal, canal_usuario_id, nombre_usuario)
values ('telegram', '123456', 'Vecino Prueba');

insert into public.mensajes (conversacion_id, direccion, texto)
select id, 'entrante', 'hola' from public.conversaciones where canal_usuario_id = '123456';
insert into public.mensajes (conversacion_id, direccion, texto, origen_respuesta)
select id, 'saliente', 'Hola, soy Migue', 'flujo' from public.conversaciones where canal_usuario_id = '123456';

do $$
declare n int;
begin
  select cantidad_mensajes into n from public.conversaciones where canal_usuario_id = '123456';
  if n <> 2 then raise exception 'el contador deberia ser 2, es %', n; end if;
end $$;
\echo '   OK: el trigger mantiene el contador'

-- ---------------------------------------------------------------------------
-- G · Agrupación de preguntas sin responder
--
-- Esta prueba existe porque su ausencia dejó pasar un error a producción: la
-- función tenía un `insert ... returning` sin envolver, que en plpgsql falla
-- con «query has no destination for result data». El esquema se aplicó sin
-- quejarse y el fallo apareció recién al llamarla desde el bot.
-- ---------------------------------------------------------------------------
\echo ''
\echo '== G · agrupacion de preguntas sin responder =='

do $$
declare r1 record; r3 record; n int; filas int;
begin
  select * into r1 from public.agrupar_sin_respuesta('donde tiro el aceite de cocina usado', 'sin_coincidencia');
  if r1.agrupada then raise exception 'la primera no deberia agruparse'; end if;

  -- Contar las FILAS que devuelve la función, no sólo mirar la primera.
  --
  -- Esta verificación es la que faltaba y dejó pasar un bug a producción:
  -- `return query` en plpgsql no termina la función, acumula. La rama de
  -- agrupación devolvía su fila y después caía en el INSERT, insertando un
  -- duplicado y devolviendo DOS filas. Un `select * into` toma la primera en
  -- silencio, así que el test pasaba igual.
  select count(*) into filas
    from public.agrupar_sin_respuesta('donde tiro el aceite de cocina usado?', 'sin_coincidencia');
  if filas <> 1 then raise exception 'la funcion devolvio % filas, deberia devolver 1', filas; end if;

  select veces_repetida into n from public.sin_respuesta
   where pregunta = 'donde tiro el aceite de cocina usado';
  if n <> 2 then raise exception 'el contador deberia ser 2, es %', n; end if;

  -- Y que no haya insertado filas de más al agrupar.
  select count(*) into filas from public.sin_respuesta
   where pregunta ilike '%aceite de cocina%';
  if filas <> 1 then raise exception 'quedaron % filas de aceite, deberia haber 1', filas; end if;

  -- Una pregunta distinta sí crea fila propia.
  select * into r3 from public.agrupar_sin_respuesta('cuanto sale el permiso de poda de arbol', 'sin_coincidencia');
  if r3.agrupada then raise exception 'una pregunta distinta no deberia agruparse'; end if;

  -- Y la de arriba fue una sola fila, no dos.
  select count(*) into filas from public.sin_respuesta;
  if filas <> 2 then raise exception 'deberian haber 2 filas en total, hay %', filas; end if;

end $$;
\echo '   OK: agrupa las parecidas, separa las distintas, sin filas duplicadas'

-- ---------------------------------------------------------------------------
-- H · Búsqueda de conocimiento
-- ---------------------------------------------------------------------------
\echo ''
\echo '== H · busqueda de conocimiento =='

-- Un documento con dos fragmentos y dos FAQs, para probar el ranking mezclado.
insert into public.documentos (titulo, nombre_archivo, formato, ruta_storage, bytes, estado)
values ('Programa CONTROLA', 'controla.pdf', 'pdf', 'docs/prueba-controla.pdf', 2000, 'listo')
on conflict (ruta_storage) do nothing;

insert into public.fragmentos (documento_id, orden, texto, titulo_seccion, pagina)
select d.id, 1,
       'El control y monitoreo de camiones compactadores se realiza por sistema de GPS para verificar la recoleccion domiciliaria en todos los sectores.',
       'Recoleccion domiciliaria', 12
  from public.documentos d where d.ruta_storage = 'docs/prueba-controla.pdf'
on conflict (documento_id, orden) do nothing;

insert into public.faqs (pregunta, respuesta, etiquetas) values
  ('¿Cómo verifico el recorrido del camión?',
   'Podés consultar el mapa oficial de recolección por turno en la web del municipio.',
   array['recoleccion'])
on conflict do nothing;

do $$
declare n int; primero record; r record;
begin
  -- 1 · Encuentra en las dos tablas
  select count(*) into n from public.buscar_conocimiento('recoleccion domiciliaria camiones');
  if n < 1 then raise exception 'no encontro el fragmento de recoleccion'; end if;

  -- 2 · La FAQ le gana al fragmento cuando las dos coinciden
  select * into primero from public.buscar_conocimiento('recorrido del camion recoleccion') limit 1;
  if primero.origen <> 'faq' then
    raise exception 'gano un % en vez de la faq; el impulso no se aplico', primero.origen;
  end if;

  -- 3 · Los fragmentos traen la referencia para poder citar
  select * into r from public.buscar_conocimiento('monitoreo GPS compactadores')
   where origen = 'fragmento' limit 1;
  if r.documento_titulo is null then raise exception 'el fragmento no trae el titulo del documento'; end if;
  if r.pagina is null then raise exception 'el fragmento no trae la pagina para citar'; end if;

  -- 4 · Sin acentos igual encuentra
  select count(*) into n from public.buscar_conocimiento('recoleccion domiciliaria');
  if n < 1 then raise exception 'la busqueda sin acentos no encontro nada'; end if;

  -- 5 · Con errores de tipeo cae al respaldo difuso
  select count(*) into n from public.buscar_conocimiento('recoridro del camoin')
   where difuso;
  if n < 1 then raise exception 'el respaldo difuso no se activo con errores de tipeo'; end if;

  -- 6 · Una consulta vacia o sin palabras utiles no devuelve nada
  select count(*) into n from public.buscar_conocimiento('');
  if n <> 0 then raise exception 'una consulta vacia devolvio % filas', n; end if;
  select count(*) into n from public.buscar_conocimiento('???');
  if n <> 0 then raise exception 'una consulta sin palabras devolvio % filas', n; end if;

  -- 7 · Un documento dado de baja deja de citarse
  update public.documentos set activo = false where ruta_storage = 'docs/prueba-controla.pdf';
  select count(*) into n from public.buscar_conocimiento('monitoreo GPS compactadores')
   where origen = 'fragmento';
  if n <> 0 then raise exception 'un documento inactivo sigue apareciendo'; end if;
  update public.documentos set activo = true where ruta_storage = 'docs/prueba-controla.pdf';

  -- 8 · Un documento que todavia se esta procesando tampoco se cita
  update public.documentos set estado = 'procesando' where ruta_storage = 'docs/prueba-controla.pdf';
  select count(*) into n from public.buscar_conocimiento('monitoreo GPS compactadores')
   where origen = 'fragmento';
  if n <> 0 then raise exception 'un documento en proceso sigue apareciendo'; end if;
  update public.documentos set estado = 'listo' where ruta_storage = 'docs/prueba-controla.pdf';

  -- 9 · Una FAQ desactivada deja de responder
  update public.faqs set activa = false where pregunta like '%recorrido del camión%';
  select count(*) into n from public.buscar_conocimiento('recorrido del camion') where origen = 'faq';
  if n <> 0 then raise exception 'una faq inactiva sigue respondiendo'; end if;
  update public.faqs set activa = true where pregunta like '%recorrido del camión%';

  -- 10 · Respeta el limite pedido
  select count(*) into n from public.buscar_conocimiento('recoleccion', null, 1);
  if n > 1 then raise exception 'devolvio % filas con limite 1', n; end if;

  -- 11 · NIVEL 2 (OR con terminos expandidos)
  --
  -- Esta prueba cubre un bug de diseno que costo una vuelta completa:
  -- websearch_to_tsquery une los terminos con AND, asi que concatenar los
  -- terminos expandidos a la consulta hacia la busqueda MAS restrictiva en vez
  -- de mas amplia. La expansion lograba exactamente lo contrario de su
  -- proposito, y el sintoma era un bot que no encontraba material que si
  -- estaba en la base.
  --
  -- El nivel OR tambien opera SIN expansion: arma la consulta OR con las
  -- palabras de la consulta original. Eso ya recupera casos que el AND pierde.
  --
  -- Para probar que el parametro de terminos expandidos aporta algo, hace falta
  -- una consulta cuyas palabras NO aparezcan en ningun material: "levantan la
  -- basura" es como habla un vecino, y los documentos dicen "recoleccion" y
  -- "compactadores". Sin expansion no hay con que encontrarlo.
  select count(*) into n from public.buscar_conocimiento('levantan la basura');
  if n <> 0 then
    raise exception 'sin expansion no deberia encontrar nada, devolvio %', n;
  end if;

  -- Con los terminos institucionales, si.
  select count(*) into n from public.buscar_conocimiento(
    'levantan la basura', 'recoleccion domiciliaria compactadores monitoreo');
  if n = 0 then
    raise exception 'el nivel OR con terminos expandidos no encontro nada';
  end if;

  -- Y lo que devuelve el nivel OR NO es difuso: son coincidencias reales de
  -- texto completo, no parecidos ortograficos. La distincion importa porque
  -- esMaterialSuficiente() rechaza lo difuso y aceptaria esto.
  select count(*) into n from public.buscar_conocimiento(
    'levantan la basura', 'recoleccion domiciliaria compactadores monitoreo') where difuso;
  if n <> 0 then raise exception 'el nivel OR marco % filas como difusas', n; end if;

  -- 12 · Terminos con signos raros no rompen to_tsquery. Los escribe un modelo
  -- de lenguaje, asi que pueden venir con parentesis, ampersands o porcentajes.
  select count(*) into n from public.buscar_conocimiento(
    'zzzzinexistente', 'recoleccion (GPS) & camiones | 50 por ciento');
  if n is null then raise exception 'terminos con signos rompieron la funcion'; end if;
end $$;
\echo '   OK: rankea, cita, tolera tipeos y respeta bajas'

-- Contadores de uso
do $$
declare v_id uuid; n int;
begin
  select id into v_id from public.faqs limit 1;
  select veces_usada into n from public.faqs where id = v_id;
  perform public.registrar_uso_faq(array[v_id]);
  if (select veces_usada from public.faqs where id = v_id) <> n + 1 then
    raise exception 'el contador de uso de la faq no se incremento';
  end if;
end $$;
\echo '   OK: los contadores de uso se incrementan'

\echo ''
-- ---------------------------------------------------------------------------
-- BLOQUE I - Ingesta: reemplazo de fragmentos y cierre de trabajos (016)
-- ---------------------------------------------------------------------------
\echo ' I. Ingesta: reemplazar_fragmentos / terminar_trabajo / encolar_reindexado'

do $$
declare
  v_doc  uuid;
  v_trab uuid;
  v_fila public.trabajos;
  v_activos int;
  n int;
begin
  insert into public.documentos
    (titulo, nombre_archivo, formato, ruta_storage, bytes, estado)
  values ('Prueba de ingesta', 'prueba.pdf', 'pdf', 'documentos/prueba-ingesta.pdf', 1234, 'procesando')
  returning id into v_doc;

  -- 1 - Inserta los fragmentos y deja el documento listo.
  select public.reemplazar_fragmentos(
    v_doc,
    '[{"orden":1,"texto":"los contenedores son 46 en total","pagina":13,"titulo_seccion":"4. Contenedores","tokens_aprox":9},
      {"orden":2,"texto":"el retiro de poda se coordina con turno previo","pagina":14,"titulo_seccion":"4. Contenedores","tokens_aprox":12}]'::jsonb,
    24, 'abc123'
  ) into n;
  if n <> 2 then raise exception 'reemplazar_fragmentos devolvio % en vez de 2', n; end if;

  select cantidad_fragmentos into n from public.documentos where id = v_doc;
  if n <> 2 then raise exception 'cantidad_fragmentos quedo en % y no en 2', n; end if;
  if (select estado from public.documentos where id = v_doc) <> 'listo' then
    raise exception 'el documento no quedo listo';
  end if;
  if (select paginas from public.documentos where id = v_doc) <> 24 then
    raise exception 'no guardo la cantidad de paginas';
  end if;
  if (select hash_sha256 from public.documentos where id = v_doc) <> 'abc123' then
    raise exception 'no guardo el hash';
  end if;

  -- 2 - La columna generada de busqueda se llena, incluyendo el titulo de
  --     seccion. Es lo que hace que un fragmento sea encontrable por el nombre
  --     de su seccion y no solo por su texto.
  select count(*) into n from public.fragmentos
   where documento_id = v_doc
     and busqueda @@ to_tsquery('public.es_sin_acentos', 'contenedores');
  if n < 1 then raise exception 'el fragmento no es buscable por su titulo de seccion'; end if;

  -- 3 - Reemplazar de verdad reemplaza: no acumula.
  select public.reemplazar_fragmentos(
    v_doc, '[{"orden":1,"texto":"texto nuevo unico","pagina":null,"titulo_seccion":null,"tokens_aprox":4}]'::jsonb
  ) into n;
  if n <> 1 then raise exception 'tras reemplazar quedaron % fragmentos y no 1', n; end if;
  select count(*) into n from public.fragmentos
   where documento_id = v_doc and texto like '%46 en total%';
  if n <> 0 then raise exception 'los fragmentos viejos sobrevivieron al reemplazo'; end if;

  -- Y un reemplazo sin p_paginas no borra las paginas ya guardadas.
  if (select paginas from public.documentos where id = v_doc) <> 24 then
    raise exception 'un reemplazo sin p_paginas borro las paginas anteriores';
  end if;

  -- 4 - Cero fragmentos es un error del documento, no un exito silencioso. Un
  --     PDF escaneado sin capa de texto entra por aca, y si quedara en 'listo'
  --     el panel mostraria un documento cargado que no responde nada.
  select public.reemplazar_fragmentos(v_doc, '[]'::jsonb) into n;
  if n <> 0 then raise exception 'devolvio % con lista vacia', n; end if;
  if (select estado from public.documentos where id = v_doc) <> 'error' then
    raise exception 'un documento sin fragmentos no quedo en error';
  end if;
  if (select error_detalle from public.documentos where id = v_doc) is null then
    raise exception 'no explico por que quedo en error';
  end if;

  -- 5 - Un documento que no existe falla fuerte, en vez de crear fragmentos
  --     huerfanos que nadie va a encontrar ni borrar.
  begin
    perform public.reemplazar_fragmentos(gen_random_uuid(), '[]'::jsonb);
    raise exception 'acepto un documento inexistente';
  exception when others then
    if sqlerrm not like 'no existe el documento%' then raise; end if;
  end;

  -- 6 - terminar_trabajo: exito.
  insert into public.trabajos (tipo, payload, max_intentos)
  values ('ingestar_documento', jsonb_build_object('documento_id', v_doc), 3)
  returning id into v_trab;

  select * into v_fila from public.tomar_trabajo('prueba-worker');
  if v_fila.id is null then raise exception 'tomar_trabajo no devolvio nada'; end if;

  select * into v_fila from public.terminar_trabajo(v_fila.id);
  if v_fila.estado <> 'listo' then
    raise exception 'un trabajo sin error quedo en % y no en listo', v_fila.estado;
  end if;
  if v_fila.finalizado_en is null then raise exception 'no marco finalizado_en'; end if;

  -- 7 - Con error y con intentos disponibles vuelve a la cola liberada.
  insert into public.trabajos (tipo, payload, max_intentos)
  values ('reindexar_documento', jsonb_build_object('documento_id', v_doc), 3)
  returning id into v_trab;

  select * into v_fila from public.tomar_trabajo('prueba-worker');
  select * into v_fila from public.terminar_trabajo(v_fila.id, 'se cayo la red');
  if v_fila.estado <> 'pendiente' then
    raise exception 'con intentos disponibles quedo en % y no en pendiente', v_fila.estado;
  end if;
  if v_fila.tomado_por is not null or v_fila.tomado_en is not null then
    raise exception 'volvio a la cola sin liberar el dueno';
  end if;
  if v_fila.finalizado_en is not null then
    raise exception 'marco finalizado_en un trabajo que todavia va a reintentarse';
  end if;

  -- 8 - Agotados los intentos queda en error. `tomar_trabajo` es lo que
  --     incrementa `intentos`, asi que hay que tomarlo y fallarlo hasta el tope.
  --     El bucle tiene salida por fila nula para no colgarse si algo cambia.
  loop
    select * into v_fila from public.tomar_trabajo('prueba-worker');
    exit when v_fila.id is null;
    select * into v_fila from public.terminar_trabajo(v_fila.id, 'sigue fallando');
    exit when v_fila.estado = 'error';
  end loop;
  if v_fila.estado <> 'error' then
    raise exception 'nunca llego a error: quedo en %', coalesce(v_fila.estado, '(sin fila)');
  end if;
  if v_fila.intentos <> v_fila.max_intentos then
    raise exception 'llego a error con % intentos de %', v_fila.intentos, v_fila.max_intentos;
  end if;

  -- 8bis - p_definitivo corta los reintentos de una vez, sin importar cuantos
  --        intentos quedaran. Es el caso del PDF escaneado: reintentarlo tres
  --        veces es bajar y procesar el mismo archivo tres veces para llegar al
  --        mismo lugar.
  insert into public.trabajos (tipo, payload, max_intentos)
  values ('ingestar_documento', jsonb_build_object('documento_id', v_doc), 5)
  returning id into v_trab;

  select * into v_fila from public.tomar_trabajo('prueba-worker');
  select * into v_fila from public.terminar_trabajo(v_fila.id, 'es un escaneo sin texto', true);
  if v_fila.estado <> 'error' then
    raise exception 'p_definitivo no corto los reintentos: quedo en %', v_fila.estado;
  end if;
  if v_fila.intentos >= v_fila.max_intentos then
    raise exception 'el test no probo nada: ya no quedaban intentos (% de %)',
      v_fila.intentos, v_fila.max_intentos;
  end if;
  if v_fila.finalizado_en is null then
    raise exception 'un cierre definitivo no marco finalizado_en';
  end if;
  if v_fila.tomado_por is null then
    raise exception 'un cierre definitivo libero el dueno y ya no se puede auditar';
  end if;

  -- 9 - Un trabajo inexistente falla en vez de devolver una fila vacia, que el
  --     worker interpretaria como cierre exitoso.
  begin
    perform public.terminar_trabajo(gen_random_uuid());
    raise exception 'acepto un trabajo inexistente';
  exception when others then
    if sqlerrm not like 'no existe el trabajo%' then raise; end if;
  end;

  -- Limpieza de la cola antes de medir el encolado masivo.
  delete from public.trabajos;

  -- 10 - encolar_reindexado: uno por documento activo, ni uno mas.
  select count(*) into v_activos from public.documentos where activo;
  select public.encolar_reindexado() into n;
  if n <> v_activos then
    raise exception 'encolo % trabajos para % documentos activos', n, v_activos;
  end if;
  select count(*) into n from public.trabajos
   where tipo = 'reindexar_documento' and estado = 'pendiente';
  if n <> v_activos then
    raise exception 'quedaron % pendientes para % documentos activos', n, v_activos;
  end if;

  -- 11 - Llamarlo de nuevo no duplica: en el panel esto va a ser un boton que
  --      alguien aprieta tres veces sin esperar.
  if public.encolar_reindexado() <> 0 then
    raise exception 'encolar_reindexado duplico trabajos ya pendientes';
  end if;

  -- Limpieza: la cola y el documento de prueba con su cascada de fragmentos.
  delete from public.trabajos;
  delete from public.documentos where id = v_doc;
end $$;
\echo '   OK: reemplazo atomico, reintentos acotados y encolado sin duplicar'

-- ---------------------------------------------------------------------------
-- BLOQUE J - RLS: que «estar logueado» NO alcance (017)
-- ---------------------------------------------------------------------------
-- Este bloque existe porque la version anterior de la auditoria contaba
-- politicas sin mirar que permitian: las diez tablas de contenido tenian una
-- politica cada una, y esa politica era `using (true)`. La vista decia
-- "1 politica" y parecia todo en orden.
\echo ' J. RLS: estar logueado no alcanza'

do $$
declare n int; v_alerta text;
begin
  -- 1 - Ninguna politica puede quedar con `using (true)` ni alcanzar a anon.
  --     Es la asercion que habria evitado el agujero original.
  select count(*) into n from public.v_auditoria_rls where alerta is not null
     and alerta <> 'sin politicas: nadie accede (falla cerrada, ok)';
  if n > 0 then
    select string_agg(distinct tabla || ': ' || alerta, '; ') into v_alerta
      from public.v_auditoria_rls where alerta is not null
       and alerta <> 'sin politicas: nadie accede (falla cerrada, ok)';
    raise exception 'quedaron % politicas permisivas -> %', n, v_alerta;
  end if;

  -- 2 - Las tablas con datos de vecinos tienen politicas, y su condicion
  --     menciona el padron. Si alguien vuelve a poner `true`, esto lo caza.
  foreach v_alerta in array array['conversaciones','mensajes','sin_respuesta','tickets','program_requests']
  loop
    select count(*) into n from public.v_auditoria_rls
     where tabla = v_alerta
       and politica is not null
       and condicion_lectura like '%es_personal_panel%';
    if n < 1 then
      raise exception 'la tabla % no exige personal habilitado para leer', v_alerta;
    end if;
  end loop;

  -- 3 - Ninguna security definer puede quedar ejecutable por anon o por public.
  --     Es el otro camino que salteaba el RLS por completo.
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.prosecdef
     and p.proname not in ('es_personal_panel','es_admin_panel')
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('public', p.oid, 'execute'));
  if n > 0 then
    raise exception '% funciones security definer siguen ejecutables por anon/public', n;
  end if;

  -- 4 - Y las que el bot necesita siguen funcionando para service_role.
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('buscar_conocimiento','agrupar_sin_respuesta',
                       'registrar_uso_faq','registrar_uso_respuesta_fija')
     and has_function_privilege('service_role', p.oid, 'execute');
  if n < 4 then
    raise exception 'el bot perdio el permiso de ejecutar sus funciones (% de 4)', n;
  end if;

  -- 5 - anon sigue sin poder tocar ninguna tabla. Es lo que ya cerraba la 007 y
  --     no se puede perder al reescribir las politicas.
  select count(*) into n from pg_policies
   where schemaname = 'public' and 'anon' = any(roles);
  if n > 0 then raise exception '% politicas alcanzan a anon', n; end if;
end $$;
\echo '   OK: sin politicas permisivas, sin definers abiertas, el bot conserva sus permisos'

-- El predicado se comporta como debe segun quien pregunte. Se prueba con
-- `set role` en vez de con un JWT: auth.uid() lee un ajuste de la sesion, asi
-- que se lo puede simular sin levantar Supabase Auth.
do $$
declare v_uid uuid := '11111111-1111-1111-1111-111111111111';
begin
  -- `personal_panel.usuario_id` referencia `auth.users`, asi que el usuario
  -- tiene que existir. En Supabase lo crea Auth; aca lo crea el stub.
  insert into auth.users (id, email, email_confirmed_at)
  values (v_uid, 'prueba@smt.gob.ar', now())
  on conflict (id) do nothing;

  -- Sin fila en el padron, el predicado dice que no.
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  if public.es_personal_panel() then
    raise exception 'un usuario que NO esta en el padron paso el chequeo';
  end if;

  -- Con fila activa, dice que si.
  insert into public.personal_panel (usuario_id, correo, rol)
  values (v_uid, 'prueba@smt.gob.ar', 'operador')
  on conflict (usuario_id) do update set activo = true;
  if not public.es_personal_panel() then
    raise exception 'un usuario habilitado NO paso el chequeo';
  end if;

  -- Dado de baja, vuelve a decir que no. Es lo que pasa el dia que alguien deja
  -- el area: se desactiva la fila y pierde el acceso sin borrar el registro.
  --
  -- OJO CON EL CLAIM. Este bloque tiene `request.jwt.claim.sub` puesto en
  -- `v_uid` para poder evaluar `es_personal_panel()` como esa persona. Pero eso
  -- hace que `auth.uid()` devuelva `v_uid`, y el trigger de la 027 —que impide
  -- que alguien se saque a si mismo el acceso— dispara y bloquea el UPDATE.
  --
  -- El trigger tiene razon: si un panel hiciera esto, seria alguien
  -- desactivandose a si mismo. Pero aca es PREPARACION de la prueba, no una
  -- accion de usuario, asi que se limpia el claim para hacer el cambio y se
  -- vuelve a poner para medir. La distincion importa y por eso queda escrita:
  -- confundir «armar el escenario» con «lo que hace un usuario» es como se
  -- escriben pruebas que miden otra cosa.
  perform set_config('request.jwt.claim.sub', '', true);
  update public.personal_panel set activo = false where usuario_id = v_uid;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  if public.es_personal_panel() then
    raise exception 'un usuario dado de baja siguio teniendo acceso';
  end if;

  -- Un operador no es admin: no puede tocar el padron.
  perform set_config('request.jwt.claim.sub', '', true);
  update public.personal_panel set activo = true, rol = 'operador' where usuario_id = v_uid;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  if public.es_admin_panel() then
    raise exception 'un operador quedo con permisos de admin';
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  update public.personal_panel set rol = 'admin' where usuario_id = v_uid;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  if not public.es_admin_panel() then
    raise exception 'un admin no fue reconocido como admin';
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.personal_panel where usuario_id = v_uid;
  delete from auth.users where id = v_uid;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
-- El agujero original, probado de verdad y no por definicion de politica.
--
-- Los bloques anteriores verifican que las politicas MENCIONEN es_personal_panel().
-- Eso no alcanza: hay que comprobar que efectivamente bloqueen. Y para eso hay
-- que asumir el rol `authenticated`, porque el arnes corre como `postgres`, que
-- saltea RLS. Un test sin `set local role` mira la definicion, no el efecto.
do $$
declare
  v_intruso uuid := '55555555-5555-5555-5555-555555555555';
  v_del_padron uuid := '66666666-6666-6666-6666-666666666666';
  n int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_intruso,    'cualquiera@gmail.com',  now()),
    (v_del_padron, 'del.area@smt.gob.ar',   now())
  on conflict (id) do nothing;

  -- El del padron si, el intruso NO. Es exactamente el escenario que estaba
  -- abierto: una cuenta valida en auth.users, sin habilitacion.
  insert into public.personal_panel (usuario_id, correo, nombre, rol)
  values (v_del_padron, 'del.area@smt.gob.ar', 'Del Area', 'operador')
  on conflict (usuario_id) do update set activo = true;

  -- Hace falta que haya algo para leer, o el test pasaria con la tabla vacia.
  insert into public.tickets (ticket_type, status, address, chat_id, user_name, sla_deadline)
  values ('Pedido No Habitual', 'En Proceso', 'Direccion de prueba K', '999', 'Vecino Prueba',
          now() + interval '3 days');

  -- 1 - El INTRUSO no ve ni un ticket.
  perform set_config('request.jwt.claim.sub', v_intruso::text, true);
  set local role authenticated;
  select count(*) into n from public.tickets;
  reset role;
  if n <> 0 then
    raise exception 'una cuenta fuera del padron leyo % tickets con datos de vecinos', n;
  end if;

  -- 2 - Ni puede escribirlos.
  perform set_config('request.jwt.claim.sub', v_intruso::text, true);
  set local role authenticated;
  begin
    update public.tickets set status = 'Resuelto' where address = 'Direccion de prueba K';
    if found then
      reset role;
      raise exception 'una cuenta fuera del padron pudo MODIFICAR un ticket';
    end if;
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 3 - Ni puede reescribir lo que el bot le dice a un vecino.
  perform set_config('request.jwt.claim.sub', v_intruso::text, true);
  set local role authenticated;
  begin
    update public.textos_bot set texto = 'texto suplantado' where clave = 'bienvenida';
    if found then
      reset role;
      raise exception 'una cuenta fuera del padron pudo reescribir textos_bot';
    end if;
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 4 - Y el del padron SI ve. Sin esto, un RLS que niega todo pasaria el test
  --     y el panel no funcionaria.
  perform set_config('request.jwt.claim.sub', v_del_padron::text, true);
  set local role authenticated;
  select count(*) into n from public.tickets;
  reset role;
  if n < 1 then
    raise exception 'el personal habilitado no puede leer tickets (%)', n;
  end if;

  -- 5 - anon, con o sin sesion, no ve nada. Es la barrera que puso la 007.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  select count(*) into n from public.tickets;
  reset role;
  if n <> 0 then raise exception 'anon leyo % tickets', n; end if;

  delete from public.tickets where address = 'Direccion de prueba K';
  delete from public.personal_panel where usuario_id = v_del_padron;
  delete from auth.users where id in (v_intruso, v_del_padron);
end $$;
\echo '   OK: fuera del padron no se lee ni se escribe NADA (probado, no deducido)'

\echo '   OK: el padron habilita, la baja quita el acceso y el rol se respeta'

-- ---------------------------------------------------------------------------
-- BLOQUE K - Lo que la 018 le abre al panel, y lo que NO
-- ---------------------------------------------------------------------------
\echo ' K. Panel: storage, probar_conocimiento y nombres sin correo'

do $$
declare
  v_a uuid := '22222222-2222-2222-2222-222222222222';
  v_b uuid := '33333333-3333-3333-3333-333333333333';
  n int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_a, 'operador.a@smt.gob.ar', now()),
    (v_b, 'operador.b@smt.gob.ar', now())
  on conflict (id) do nothing;
  insert into public.personal_panel (usuario_id, correo, nombre, rol) values
    (v_a, 'operador.a@smt.gob.ar', 'Operador A', 'operador'),
    (v_b, 'operador.b@smt.gob.ar', 'Operador B', 'operador')
  on conflict (usuario_id) do update set activo = true;

  perform set_config('request.jwt.claim.sub', v_a::text, true);

  -- 1 - personal_nombres devuelve a TODO el padron activo, con nombre y rol.
  select count(*) into n from public.personal_nombres();
  if n < 2 then
    raise exception 'personal_nombres devolvio % filas, esperaba al menos 2', n;
  end if;

  -- 2 - Y NO devuelve el correo. Es lo que la funcion viene a proteger: para
  --     mostrar «lo resolvio X» alcanza el nombre, la lista de direcciones del
  --     personal municipal no hace falta.
  --     La primera version de la 018 usaba una vista mas una politica que
  --     abria la fila; RLS es por FILA y no por columna, asi que eso exponia el
  --     correo de todos. Este test es el que lo caza.
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'personal_nombres'
     and column_name = 'correo';
  if n > 0 then raise exception 'personal_nombres expone el correo'; end if;

  -- 3 - Un operador NO puede leer la fila de otro directamente en la tabla.
  --
  --     Hay que asumir el rol `authenticated` para probarlo: el arnes corre como
  --     `postgres`, que es superusuario y SALTEA RLS. Sin este `set local role`,
  --     la consulta devuelve la fila siempre y el test no prueba nada — fue
  --     justamente lo que paso la primera vez que se escribio.
  set local role authenticated;
  select count(*) into n from public.personal_panel where usuario_id = v_b;
  reset role;
  if n <> 0 then
    raise exception 'un operador puede leer la fila de otro en personal_panel (%)', n;
  end if;

  -- 3bis - Y con el rol puesto, la funcion SI le da los nombres. Es la
  --        diferencia entre «no ve la tabla» y «no ve nada»: el panel necesita
  --        resolver un uuid a un nombre sin poder leer los correos.
  set local role authenticated;
  select count(*) into n from public.personal_nombres();
  reset role;
  if n < 2 then
    raise exception 'con rol authenticated, personal_nombres devolvio %', n;
  end if;

  -- 4 - Sin padron, personal_nombres rechaza en vez de devolver vacio. La
  --     diferencia importa: vacio se confunde con «no hay nadie cargado».
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
  begin
    perform public.personal_nombres();
    raise exception 'personal_nombres atendio a alguien fuera del padron';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.probar_conocimiento('prueba');
    raise exception 'probar_conocimiento atendio a alguien fuera del padron';
  exception when insufficient_privilege then
    null;
  end;

  -- 5 - Con padron, probar_conocimiento responde lo MISMO que buscar_conocimiento.
  --     Si divergieran, el panel probaria una cosa y el vecino recibiria otra.
  perform set_config('request.jwt.claim.sub', v_a::text, true);
  select count(*) into n from public.probar_conocimiento('recoleccion domiciliaria');
  if n <> (select count(*) from public.buscar_conocimiento('recoleccion domiciliaria')) then
    raise exception 'probar_conocimiento devuelve algo distinto que buscar_conocimiento';
  end if;

  -- 6 - Las politicas del bucket existen y ninguna es permisiva.
  select count(*) into n from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'panel_documentos_%';
  if n <> 3 then
    raise exception 'esperaba 3 politicas del bucket documentos, hay %', n;
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'panel_documentos_%'
     and (coalesce(qual,'') || coalesce(with_check,'')) not like '%es_personal_panel%';
  if n > 0 then
    raise exception '% politicas del bucket no exigen el padron', n;
  end if;

  -- 7 - Y no hay politica de DELETE: el borrado pasa por la cola del worker.
  select count(*) into n from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and cmd = 'DELETE';
  if n > 0 then
    raise exception 'hay % politicas de DELETE en storage.objects', n;
  end if;

  -- 8 - Las dos claves que el codigo lee tienen fila.
  select count(*) into n from public.configuracion
   where clave in ('umbral_confianza_router','exclusiones_durante_flujo');
  if n <> 2 then
    raise exception 'faltan claves de configuracion que el codigo lee: hay % de 2', n;
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.personal_panel where usuario_id in (v_a, v_b);
  delete from auth.users where id in (v_a, v_b);
end $$;
\echo '   OK: el panel puede subir y probar, y no ve correos ajenos'

-- ---------------------------------------------------------------------------
-- BLOQUE L - Respuestas: quien publica y como se prueba un disparador (019)
-- ---------------------------------------------------------------------------
\echo ' L. Respuestas: operador carga, supervisor publica, disparadores probados'

do $$
declare
  v_op   uuid := '77777777-7777-7777-7777-777777777777';
  v_sup  uuid := '88888888-8888-8888-8888-888888888888';
  v_conv uuid;
  n int;
  v_coincide boolean;
  v_mirados int;
  v_atrapados int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_op,  'operador@smt.gob.ar',   now()),
    (v_sup, 'supervisor@smt.gob.ar', now())
  on conflict (id) do nothing;
  insert into public.personal_panel (usuario_id, correo, nombre, rol) values
    (v_op,  'operador@smt.gob.ar',   'Operadora', 'operador'),
    (v_sup, 'supervisor@smt.gob.ar', 'Supervisor','supervisor')
  on conflict (usuario_id) do update set activo = true, rol = excluded.rol;

  -- 1 - Un OPERADOR puede crear un borrador.
  perform set_config('request.jwt.claim.sub', v_op::text, true);
  set local role authenticated;
  insert into public.faqs (pregunta, respuesta, activa)
  values ('¿Donde llevo los neumaticos?', 'En los Puntos Verdes.', false);
  reset role;

  select count(*) into n from public.faqs where pregunta like '%neumaticos%';
  if n <> 1 then raise exception 'el operador no pudo crear un borrador'; end if;

  -- 2 - Pero NO puede crear algo ya publicado. Es la diferencia entre «escribi
  --     una respuesta» y «esto ya se lo estamos diciendo a los vecinos».
  perform set_config('request.jwt.claim.sub', v_op::text, true);
  set local role authenticated;
  begin
    insert into public.faqs (pregunta, respuesta, activa)
    values ('¿Publico sin revision?', 'No deberia poder.', true);
    reset role;
    raise exception 'un operador pudo crear una FAQ ya publicada';
  exception when insufficient_privilege then
    reset role;
  end;

  -- 3 - Ni publicar una que ya existe.
  perform set_config('request.jwt.claim.sub', v_op::text, true);
  set local role authenticated;
  begin
    update public.faqs set activa = true where pregunta like '%neumaticos%';
    reset role;
    raise exception 'un operador pudo PUBLICAR una FAQ';
  exception when insufficient_privilege then
    reset role;
  end;

  -- 4 - Pero si puede seguir editando el texto del borrador.
  perform set_config('request.jwt.claim.sub', v_op::text, true);
  set local role authenticated;
  update public.faqs set respuesta = 'En cualquiera de los Puntos Verdes.'
   where pregunta like '%neumaticos%';
  reset role;
  select count(*) into n from public.faqs
   where pregunta like '%neumaticos%' and respuesta like '%cualquiera%';
  if n <> 1 then raise exception 'el operador no pudo editar su propio borrador'; end if;

  -- 5 - Un SUPERVISOR si publica.
  perform set_config('request.jwt.claim.sub', v_sup::text, true);
  set local role authenticated;
  update public.faqs set activa = true where pregunta like '%neumaticos%';
  reset role;
  select count(*) into n from public.faqs where pregunta like '%neumaticos%' and activa;
  if n <> 1 then raise exception 'el supervisor no pudo publicar'; end if;

  -- 6 - Y borrar es solo de supervisor o admin.
  perform set_config('request.jwt.claim.sub', v_op::text, true);
  set local role authenticated;
  delete from public.faqs where pregunta like '%neumaticos%';
  reset role;
  select count(*) into n from public.faqs where pregunta like '%neumaticos%';
  if n <> 1 then raise exception 'un operador pudo borrar una FAQ'; end if;

  -- 7 - probar_disparadores: coincide con el texto que se le pasa.
  perform set_config('request.jwt.claim.sub', v_op::text, true);
  select coincide_el_texto into v_coincide
    from public.probar_disparadores(array['neumatico','cubierta'], 'contiene',
                                   'donde tiro un NEUMÁTICO viejo');
  if not v_coincide then
    raise exception 'no coincidio ignorando mayusculas y acentos';
  end if;

  select coincide_el_texto into v_coincide
    from public.probar_disparadores(array['neumatico'], 'contiene', 'cuando pasa el camion');
  if v_coincide then raise exception 'coincidio con un texto que no corresponde'; end if;

  -- 8 - Y mide contra los mensajes REALES. Es la prueba que importa: un
  --     disparador puede parecer razonable y atrapar todo.
  insert into public.conversaciones (canal, canal_usuario_id)
  values ('telegram', 'prueba-L') returning id into v_conv;
  insert into public.mensajes (conversacion_id, direccion, texto) values
    (v_conv, 'entrante', 'donde llevo los neumaticos viejos'),
    (v_conv, 'entrante', 'cuando pasa el camion por mi casa'),
    (v_conv, 'entrante', 'quiero un taller para la escuela');

  select mensajes_mirados, mensajes_atrapados into v_mirados, v_atrapados
    from public.probar_disparadores(array['neumatico'], 'contiene', null);
  if v_mirados < 3 then raise exception 'miro % mensajes, esperaba al menos 3', v_mirados; end if;
  if v_atrapados <> 1 then
    raise exception 'un disparador especifico atrapo % mensajes, esperaba 1', v_atrapados;
  end if;

  -- 9 - EL CASO PELIGROSO: un regex que atrapa TODO. Es lo que esta funcion
  --     viene a hacer visible antes de publicar, porque un `.*` publicado deja
  --     al bot respondiendo lo mismo a cualquier cosa que escriba un vecino.
  select mensajes_mirados, mensajes_atrapados into v_mirados, v_atrapados
    from public.probar_disparadores(array['.*'], 'regex', null);
  if v_atrapados <> v_mirados then
    raise exception 'un regex «.*» atrapo % de % mensajes; deberia atrapar todos',
      v_atrapados, v_mirados;
  end if;

  -- 10 - Un modo invalido se rechaza en vez de no coincidir con nada en silencio.
  begin
    perform public.probar_disparadores(array['x'], 'aproximado', 'x');
    raise exception 'acepto un modo invalido';
  exception when others then
    if sqlerrm not like 'modo invalido%' then raise; end if;
  end;

  -- 11 - Y no atiende a quien no esta en el padron.
  perform set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', true);
  begin
    perform public.probar_disparadores(array['x'], 'contiene', 'x');
    raise exception 'probar_disparadores atendio a alguien fuera del padron';
  exception when insufficient_privilege then
    null;
  end;

  -- 12 - La columna que faltaba: que respuesta fija se envio.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'mensajes'
     and column_name = 'respuesta_fija_id';
  if n <> 1 then raise exception 'falta mensajes.respuesta_fija_id'; end if;

  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.faqs where pregunta like '%neumaticos%';
  delete from public.mensajes where conversacion_id = v_conv;
  delete from public.conversaciones where id = v_conv;
  delete from public.personal_panel where usuario_id in (v_op, v_sup);
  delete from auth.users where id in (v_op, v_sup);
end $$;
\echo '   OK: el operador no publica, el supervisor si, y un «.*» se ve antes de publicarlo'

-- ---------------------------------------------------------------------------
-- BLOQUE M - Cerrar el circuito: pregunta sin responder -> respuesta (021)
-- ---------------------------------------------------------------------------
-- Lo que se prueba aca no es que las funciones existan: es que resolver sea
-- ATOMICO y que no sea una puerta de atras para publicar.
--
-- Las dos son SECURITY DEFINER, o sea que corren con los privilegios del dueno
-- y RLS NO se les aplica. Si la verificacion de rol de adentro estuviera mal, un
-- operador podria publicar por RPC lo que las politicas de la 019 le prohiben
-- por INSERT directo, y el bloque L seguiria pasando igual.
\echo ' M. Resolver: escribir la respuesta y marcar la pregunta, en una transaccion'

do $$
declare
  v_op    uuid := '77777777-7777-7777-7777-777777777777';
  v_sup   uuid := '88888888-8888-8888-8888-888888888888';
  v_fuera uuid := '99999999-9999-9999-9999-999999999999';
  v_p1 uuid; v_p2 uuid; v_p3 uuid;
  v_faq uuid; v_fija uuid;
  v_pub boolean;
  v_estado text;
  v_titulo text;
  v_publicada boolean;
  n int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_op,  'operador@smt.gob.ar',   now()),
    (v_sup, 'supervisor@smt.gob.ar', now())
  on conflict (id) do nothing;
  insert into public.personal_panel (usuario_id, correo, nombre, rol) values
    (v_op,  'operador@smt.gob.ar',   'Operadora', 'operador'),
    (v_sup, 'supervisor@smt.gob.ar', 'Supervisor','supervisor')
  on conflict (usuario_id) do update set activo = true, rol = excluded.rol;

  insert into public.sin_respuesta (pregunta, motivo, veces_repetida)
  values ('donde tiro el aceite usado de cocina', 'sin_coincidencia', 4)
  returning id into v_p1;
  insert into public.sin_respuesta (pregunta, motivo, veces_repetida)
  values ('a que hora atiende el corralon', 'confianza_baja', 2)
  returning id into v_p2;
  insert into public.sin_respuesta (pregunta, motivo)
  values ('cuando me llega la boleta de rentas', 'fuera_de_alcance')
  returning id into v_p3;

  -- 1 - Un OPERADOR resuelve: se escribe la FAQ y la pregunta queda marcada.
  --     Las dos cosas, o ninguna.
  perform set_config('request.jwt.claim.sub', v_op::text, true);
  select faq_id, publicada into v_faq, v_pub
    from public.resolver_con_faq(v_p1, 'donde tiro el aceite usado de cocina',
                                 'En los Puntos Verdes, en botella cerrada.',
                                 array['aceite'], false);
  if v_faq is null then raise exception 'no se creo la FAQ'; end if;

  select estado, resuelta_con_faq_id into v_estado, v_faq
    from public.sin_respuesta where id = v_p1;
  if v_estado <> 'resuelta' then
    raise exception 'la pregunta quedo en «%» en vez de resuelta', v_estado;
  end if;
  if v_faq is null then
    raise exception 'la pregunta se marco resuelta pero sin vincular la respuesta';
  end if;

  -- 2 - EL CASO QUE IMPORTA: el operador pidio publicar y NO se publico.
  --     Es la unica forma de que estas funciones no sean una puerta de atras a
  --     lo que la 019 le prohibe por INSERT directo.
  perform set_config('request.jwt.claim.sub', v_op::text, true);
  select faq_id, publicada into v_faq, v_pub
    from public.resolver_con_faq(v_p2, 'a que hora atiende el corralon',
                                 'De 8 a 13.', array[]::text[], true);
  if v_pub then
    raise exception 'un operador publico usando resolver_con_faq: es una puerta de atras';
  end if;
  select activa into v_publicada from public.faqs where id = v_faq;
  if v_publicada then
    raise exception 'la FAQ quedo activa aunque la creo un operador';
  end if;

  -- 3 - Y no se pierde el trabajo: quedo el borrador escrito y la pregunta
  --     tomada. Rechazar la operacion entera seria peor.
  select estado into v_estado from public.sin_respuesta where id = v_p2;
  if v_estado <> 'resuelta' then
    raise exception 'se perdio el vinculo cuando el operador no pudo publicar';
  end if;

  -- 4 - La vista distingue «respondida» de «falta publicar». Sin esto el panel
  --     da por cerrado algo que el vecino todavia no puede recibir.
  select respuesta_titulo, respuesta_publicada, respuesta_tipo
    into v_titulo, v_publicada, v_estado
    from public.v_sin_respuesta where id = v_p2;
  if v_titulo is null then raise exception 'la vista no trae el titulo de la respuesta'; end if;
  if v_publicada is not false then
    raise exception 'la vista dice publicada=% para un borrador', v_publicada;
  end if;
  if v_estado <> 'faq' then raise exception 'la vista no dice que es una FAQ'; end if;

  -- 5 - Un SUPERVISOR si publica en el mismo paso.
  perform set_config('request.jwt.claim.sub', v_sup::text, true);
  select fija_id, publicada into v_fija, v_pub
    from public.resolver_con_fija(v_p3, 'Derivar a Rentas', array['boleta','rentas'],
                                  'contiene', 'Eso lo atiende Rentas: 0800-...',
                                  true, 'Salio de una pregunta sin responder.');
  if not v_pub then raise exception 'un supervisor no pudo publicar'; end if;

  select activa, notas into v_publicada, v_titulo from public.respuestas_fijas where id = v_fija;
  if not v_publicada then raise exception 'la fija no quedo activa'; end if;
  -- Las notas viajan: el panel tiene el campo y si la RPC no lo aceptara, se
  -- tragaria en silencio lo que se escribe ahi.
  if v_titulo is null then raise exception 'se perdieron las notas de la respuesta fija'; end if;

  -- 6 - Descartar no borra la fila: deja el motivo para poder revisarlo.
  insert into public.sin_respuesta (pregunta, motivo) values ('asdasd', 'sin_coincidencia');
  perform public.descartar_sin_respuesta(
    (select id from public.sin_respuesta where pregunta = 'asdasd'), 'No se entiende');
  select estado, notas into v_estado, v_titulo
    from public.sin_respuesta where pregunta = 'asdasd';
  if v_estado <> 'descartada' then raise exception 'no se descarto'; end if;
  if v_titulo <> 'No se entiende' then raise exception 'no quedo el motivo del descarte'; end if;

  -- 7 - Una pregunta que no existe da error, no un exito silencioso. Sin esto
  --     el panel diria «respondida» y no habria quedado nada vinculado.
  perform set_config('request.jwt.claim.sub', v_sup::text, true);
  begin
    perform public.resolver_con_faq(gen_random_uuid(), 'x', 'y', array[]::text[], false);
    raise exception 'resolvio una pregunta inexistente';
  exception when others then
    if sqlerrm not like 'no existe esa pregunta%' then raise; end if;
  end;

  -- 8 - Y no atienden a quien no esta en el padron, que es lo que las hace
  --     seguras siendo SECURITY DEFINER.
  perform set_config('request.jwt.claim.sub', v_fuera::text, true);
  begin
    perform public.resolver_con_faq(v_p1, 'x', 'y', array[]::text[], false);
    raise exception 'resolver_con_faq atendio a alguien fuera del padron';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.descartar_sin_respuesta(v_p1, 'x');
    raise exception 'descartar_sin_respuesta atendio a alguien fuera del padron';
  exception when insufficient_privilege then null;
  end;

  -- 9 - La vista hereda RLS de las tablas (security_invoker). Si se hubiera
  --     creado sin eso, correria con los permisos del dueno y cualquier cuenta
  --     autenticada leeria las preguntas de los vecinos por la vista, saltando
  --     todo lo que cerro la 017.
  perform set_config('request.jwt.claim.sub', v_fuera::text, true);
  set local role authenticated;
  select count(*) into n from public.v_sin_respuesta;
  reset role;
  if n <> 0 then
    raise exception 'una cuenta fuera del padron leyo % filas de v_sin_respuesta', n;
  end if;

  -- 10 - Y alguien del padron si las ve.
  perform set_config('request.jwt.claim.sub', v_sup::text, true);
  set local role authenticated;
  select count(*) into n from public.v_sin_respuesta;
  reset role;
  if n = 0 then raise exception 'un supervisor no ve ninguna pregunta sin responder'; end if;

  -- 11 - `anon` no toca nada de esto. Es la puerta que da a internet.
  set local role anon;
  begin
    select count(*) into n from public.v_sin_respuesta;
    if n > 0 then
      reset role;
      raise exception 'anon leyo % preguntas de vecinos', n;
    end if;
  exception when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.faqs where pregunta like '%aceite%' or pregunta like '%corralon%';
  delete from public.respuestas_fijas where nombre = 'Derivar a Rentas';
  delete from public.sin_respuesta
   where pregunta in ('donde tiro el aceite usado de cocina',
                      'a que hora atiende el corralon',
                      'cuando me llega la boleta de rentas', 'asdasd');
  delete from public.personal_panel where usuario_id in (v_op, v_sup);
  delete from auth.users where id in (v_op, v_sup);
end $$;
\echo '   OK: resolver es atomico, un operador no publica por RPC y la vista hereda RLS'

-- ---------------------------------------------------------------------------
-- BLOQUE N - El voto del vecino (022)
-- ---------------------------------------------------------------------------
-- Lo que se prueba aca no es que la tabla exista: es que el voto quede colgado
-- del mensaje CORRECTO, que tocar dos veces no cuente doble, y que el panel no
-- pueda modificarlo.
--
-- Lo primero es lo mas facil de errar. El bot manda DOS salientes por turno: la
-- respuesta y despues el "te sirvio?" con los botones. Si `registrar_voto`
-- tomara literalmente el ultimo saliente, el voto quedaria colgado del mensaje
-- de cortesia, y el panel mostraria un pulgar abajo sobre un texto que dice
-- "te sirvio?" en vez de sobre la respuesta que fallo.
\echo ' N. Voto: contra el mensaje correcto, sin contar doble, y el panel no lo toca'

do $$
declare
  v_conv uuid;
  v_respuesta uuid;
  v_cortesia uuid;
  v_otra uuid;
  v_voto uuid;
  v_mensaje uuid;
  -- `registrar_voto` devuelve jsonb desde la 029: el bot necesita distinguir
  -- «se registro ahora» de «ya estaba» para saber si agradecer o callarse.
  v_res jsonb;
  -- Conversacion aparte para las pruebas de la ventana de tiempo, y un segundo
  -- mensaje para la del valor por defecto de `sobre`. Los dos existen porque el
  -- voto ya no se puede re-votar; el comentario de cada check lo explica.
  v_conv_v uuid;
  v_mensaje2 uuid;
  v_texto text;
  v_op uuid := '77777777-7777-7777-7777-777777777777';
  v_fuera uuid := '99999999-9999-9999-9999-999999999999';
  n int;
  v_ok boolean;
begin
  insert into auth.users (id, email, email_confirmed_at)
  values (v_op, 'operador@smt.gob.ar', now()) on conflict (id) do nothing;
  insert into public.personal_panel (usuario_id, correo, nombre, rol)
  values (v_op, 'operador@smt.gob.ar', 'Operadora', 'operador')
  on conflict (usuario_id) do update set activo = true;

  insert into public.conversaciones (canal, canal_usuario_id, nombre_usuario)
  values ('telegram', 'voto-prueba-1', 'Vecino Prueba') returning id into v_conv;

  insert into public.mensajes (conversacion_id, direccion, texto)
  values (v_conv, 'entrante', 'cuando pasa el camion de poda');

  -- El turno del bot: la respuesta (con traza) y despues la cortesia (sin).
  insert into public.mensajes (conversacion_id, direccion, texto, origen_respuesta, intencion)
  values (v_conv, 'saliente', 'Los residuos verdes se retiran los martes.', 'faq', 'consulta_libre')
  returning id into v_respuesta;

  insert into public.mensajes (conversacion_id, direccion, texto)
  values (v_conv, 'saliente', 'Te sirvio esta respuesta?')
  returning id into v_cortesia;

  -- 1 - EL CASO QUE IMPORTA: el voto va contra la RESPUESTA, no contra la
  --     pregunta de cortesia, aunque esa sea el ultimo saliente.
  v_res := public.registrar_voto(v_conv, 'no_util');
  v_voto := (v_res->>'id')::uuid;
  if v_voto is null then raise exception 'no se registro el voto'; end if;
  if (v_res->>'ya_habia_votado')::boolean then
    raise exception 'el PRIMER voto vino marcado como repetido: el bot no agradeceria nunca';
  end if;

  select mensaje_id into v_mensaje from public.valoraciones where id = v_voto;
  if v_mensaje = v_cortesia then
    raise exception 'el voto quedo colgado del «te sirvio?» en vez de la respuesta';
  end if;
  if v_mensaje <> v_respuesta then
    raise exception 'el voto quedo colgado de un mensaje inesperado';
  end if;

  -- 2 - Tocar el boton dos veces NO cuenta doble. Pasa de verdad: el vecino no
  --     ve confirmacion inmediata y vuelve a tocar.
  --
  --     Y ESTE CHEQUEO NO ALCANZABA. Contaba filas, y filas duplicadas nunca
  --     hubo: el `on conflict do update` de antes CAMBIABA el voto y devolvia un
  --     id, asi que el bot volvia a agradecer en cada toque. La prueba miraba la
  --     tabla y el vecino veia la conversacion. Se agrega lo que faltaba: que la
  --     funcion AVISE que ya habia voto.
  v_res := public.registrar_voto(v_conv, 'no_util');
  select count(*) into n from public.valoraciones where conversacion_id = v_conv;
  if n <> 1 then raise exception 'dos toques crearon % filas', n; end if;
  if not (v_res->>'ya_habia_votado')::boolean then
    raise exception 'el segundo toque no vino marcado: el bot volveria a agradecer';
  end if;
  if (v_res->>'id')::uuid <> v_voto then
    raise exception 'el segundo toque devolvio otro voto';
  end if;

  -- 3 - El comentario se pega al voto negativo.
  select public.comentar_voto(v_conv, 'yo pregunte por escombros no por poda') into v_ok;
  if not v_ok then raise exception 'no se pego el comentario'; end if;
  select comentario into v_texto from public.valoraciones where id = v_voto;
  if v_texto <> 'yo pregunte por escombros no por poda' then
    raise exception 'el comentario quedo mal: %', v_texto;
  end if;

  -- 4 - Y el SEGUNDO texto ya no lo sobrescribe. Es lo que hace que el bot
  --     pueda llamar a esta funcion en cada mensaje sin destruir lo guardado.
  select public.comentar_voto(v_conv, 'otra cosa que escribio despues') into v_ok;
  if v_ok then raise exception 'sobrescribio un comentario que ya estaba'; end if;
  select comentario into v_texto from public.valoraciones where id = v_voto;
  if v_texto <> 'yo pregunte por escombros no por poda' then
    raise exception 'se perdio el comentario original';
  end if;

  -- 5 - EL VOTO NO SE CAMBIA. Este check decia lo contrario hasta la 029:
  --     probaba que cambiar de pulgar limpiara el comentario. Probando el bot
  --     se vio por que estaba mal — se podia votar 👍 👎 👍 👎 y Migue agradecia
  --     cada vez, como si cada toque contara.
  --
  --     El dato que le sirve al area es la primera reaccion, no la ultima de una
  --     serie de toques. Y un boton que contesta siempre lo mismo no le ensena
  --     al vecino que su voto ya quedo tomado.
  --
  --     Lo que se pierde, dicho de frente: el que toco por error ya no se
  --     corrige solo. La valvula es el comentario, donde puede escribir «me
  --     equivoque» y el area lo lee.
  v_res := public.registrar_voto(v_conv, 'util');
  if not (v_res->>'ya_habia_votado')::boolean then
    raise exception 'el cambio de opinion no vino marcado como repetido';
  end if;
  select voto into v_texto from public.valoraciones where id = v_voto;
  if v_texto <> 'no_util' then
    raise exception 'el voto se cambio a «%»: el primer toque tenia que ganar', v_texto;
  end if;
  --     Y el comentario sigue donde estaba. Ya no existe el cambio de voto que
  --     lo podia dejar colgado de un pulgar que no le corresponde.
  select comentario into v_texto from public.valoraciones where id = v_voto;
  if v_texto <> 'yo pregunte por escombros no por poda' then
    raise exception 'se perdio el comentario del vecino: %', v_texto;
  end if;

  -- 6 - Un voto invalido se rechaza en vez de guardarse.
  begin
    perform public.registrar_voto(v_conv, 'mas_o_menos');
    raise exception 'acepto un voto invalido';
  exception when others then
    if sqlerrm not like 'voto invalido%' then raise; end if;
  end;

  -- 7 - Una conversacion sin ninguna respuesta previa devuelve null, no explota.
  --     Pasa si alguien toca un boton viejo de una charla que ya no tiene
  --     mensajes.
  insert into public.conversaciones (canal, canal_usuario_id)
  values ('telegram', 'voto-prueba-vacia') returning id into v_otra;
  v_res := public.registrar_voto(v_otra, 'util');
  if (v_res->>'id') is not null then
    raise exception 'valoro una conversacion sin respuestas';
  end if;
  -- Y NO viene marcado como repetido. Los dos casos hacen que el bot se calle,
  -- pero significan cosas opuestas: con «repetido» el adaptador le sacaria el
  -- teclado a un vecino cuyo voto nunca entro, y se quedaria sin como reintentar.
  if (v_res->>'ya_habia_votado')::boolean then
    raise exception 'un voto que no se pudo registrar vino marcado como repetido';
  end if;

  -- 8 - Un texto vacio no crea nada.
  select public.comentar_voto(v_conv, '   ') into v_ok;
  if v_ok then raise exception 'acepto un comentario vacio'; end if;

  -- 9 - La ventana de tiempo. Con ventana cero, un voto de hace un rato ya no
  --     acepta comentario: es lo que evita que un mensaje de manana quede
  --     pegado como explicacion de un pulgar abajo de hoy.
  --
  --     Va en su PROPIA conversacion, y eso es consecuencia de la 029. Antes
  --     esta prueba conseguia un voto limpio re-votando, y ahora el primer toque
  --     gana. Valorar otro mensaje de `v_conv` tambien servia, pero le cambiaba
  --     los totales a los checks 10, 11 y 16, que cuentan sobre esa
  --     conversacion. Una conversacion aparte los deja quietos.
  insert into public.conversaciones (canal, canal_usuario_id)
  values ('telegram', 'voto-prueba-ventana') returning id into v_conv_v;

  insert into public.mensajes (conversacion_id, direccion, texto, origen_respuesta)
  values (v_conv_v, 'saliente', 'Los escombros van a un Punto Verde.', 'faq');

  perform public.registrar_voto(v_conv_v, 'no_util');
  select public.comentar_voto(v_conv_v, 'dentro de la ventana', 10) into v_ok;
  if not v_ok then raise exception 'la ventana de 10 minutos rechazo un voto recien creado'; end if;

  -- Otro mensaje, otro voto sin comentario. Sin la ventana, este texto quedaria
  -- pegado como explicacion aunque no tenga nada que ver.
  insert into public.mensajes (conversacion_id, direccion, texto, origen_respuesta)
  values (v_conv_v, 'saliente', 'El retiro de ramas se pide por aca.', 'faq');

  perform public.registrar_voto(v_conv_v, 'no_util');
  select public.comentar_voto(v_conv_v, 'fuera de la ventana', 0) into v_ok;
  if v_ok then raise exception 'una ventana de cero minutos acepto el comentario'; end if;

  -- 10 - La vista resume el voto sin que el panel tenga que traer los mensajes.
  select votos_utiles, votos_no_utiles, primer_mensaje
    into n, n, v_texto
    from public.v_conversaciones where id = v_conv;
  if v_texto <> 'cuando pasa el camion de poda' then
    raise exception 'la vista no trae el primer mensaje del vecino: %', v_texto;
  end if;
  select votos_no_utiles into n from public.v_conversaciones where id = v_conv;
  if n <> 1 then raise exception 'la vista conto % votos negativos', n; end if;

  -- 11 - La transcripcion trae el voto pegado a la respuesta que lo recibio.
  select count(*) into n from public.transcripcion(v_conv) where voto is not null;
  if n <> 1 then raise exception 'la transcripcion pego el voto a % mensajes', n; end if;
  select texto into v_texto from public.transcripcion(v_conv) where voto is not null;
  if v_texto not like 'Los residuos verdes%' then
    raise exception 'el voto quedo pegado al mensaje «%»', v_texto;
  end if;

  -- 12 - El panel LEE pero NO ESCRIBE. El voto es del vecino: que alguien del
  --      municipio pueda cambiarlo destruiria el unico dato que vale de esta
  --      tabla. Se prueba el EFECTO con `set local role`, no la definicion de
  --      la politica: el arnes corre como postgres, que saltea RLS.
  perform set_config('request.jwt.claim.sub', v_op::text, true);
  set local role authenticated;
  select count(*) into n from public.valoraciones;
  reset role;
  if n = 0 then raise exception 'el panel no puede leer las valoraciones'; end if;

  perform set_config('request.jwt.claim.sub', v_op::text, true);
  set local role authenticated;
  begin
    update public.valoraciones set voto = 'util' where conversacion_id = v_conv;
    if found then
      reset role;
      raise exception 'el panel pudo CAMBIAR el voto de un vecino';
    end if;
    reset role;
  exception when insufficient_privilege then
    reset role;
  end;

  perform set_config('request.jwt.claim.sub', v_op::text, true);
  set local role authenticated;
  begin
    delete from public.valoraciones where conversacion_id = v_conv;
    if found then
      reset role;
      raise exception 'el panel pudo BORRAR un voto';
    end if;
    reset role;
  exception when insufficient_privilege then
    reset role;
  end;

  -- 13 - Y una cuenta fuera del padron no ve nada, ni por la tabla ni por la
  --      vista. La vista es security_invoker justamente para esto.
  perform set_config('request.jwt.claim.sub', v_fuera::text, true);
  set local role authenticated;
  select count(*) into n from public.valoraciones;
  reset role;
  if n <> 0 then raise exception 'una cuenta fuera del padron leyo % votos', n; end if;

  perform set_config('request.jwt.claim.sub', v_fuera::text, true);
  set local role authenticated;
  select count(*) into n from public.v_conversaciones;
  reset role;
  if n <> 0 then
    raise exception 'una cuenta fuera del padron leyo % conversaciones por la vista', n;
  end if;

  -- 14 - Y la transcripcion tampoco es una puerta: es security invoker.
  perform set_config('request.jwt.claim.sub', v_fuera::text, true);
  set local role authenticated;
  select count(*) into n from public.transcripcion(v_conv);
  reset role;
  if n <> 0 then
    raise exception 'la transcripcion le dio % mensajes a alguien fuera del padron', n;
  end if;

  -- 15 - Los textos del voto quedaron cargados y son opcionales los que tienen
  --      que serlo: vaciarlos desde el panel es como se apaga cada encuesta.
  --      Son CINCO desde la 028, porque la del tramite se apaga por separado.
  select count(*) into n from public.textos_bot
   where clave in ('seguimiento_tras_responder','voto_gracias_util','voto_pedir_detalle',
                   'seguimiento_tras_tramite','voto_tramite_detalle')
     and opcional = true;
  if n <> 5 then raise exception 'faltan textos del voto o no son opcionales: %', n; end if;

  -- 16 - LO QUE AGREGO LA 028: hay dos encuestas distintas y la vista las tiene
  --      que separar. Salio de probar el bot: se completo un pedido de retiro
  --      entero y no pregunto nada, porque el voto solo existia despues de una
  --      RESPUESTA.
  --
  --      Se separan porque los arreglos son opuestos y los hace gente distinta:
  --      una respuesta mala se corrige escribiendo; un tramite dificil se
  --      corrige sacando un paso del flujo. Sumadas en un solo porcentaje, el
  --      area recibe un numero que no le dice que hacer.
  insert into public.mensajes (conversacion_id, direccion, texto, origen_respuesta)
  values (v_conv, 'saliente', 'Solicitud registrada. Numero AMB-1.', 'flujo')
  returning id into v_mensaje;

  v_res := public.registrar_voto(v_conv, 'no_util', v_mensaje, 'tramite');
  v_voto := (v_res->>'id')::uuid;
  if v_voto is null then raise exception 'no se registro el voto del tramite'; end if;
  if (v_res->>'ya_habia_votado')::boolean then
    raise exception 'el voto del tramite vino marcado como repetido';
  end if;

  select sobre into v_texto from public.valoraciones where id = v_voto;
  if v_texto <> 'tramite' then
    raise exception 'el voto del tramite quedo guardado como «%»', v_texto;
  end if;

  --      Y la vista los reparte. Con las dos clases mezcladas el panel muestra
  --      «no le sirvio la respuesta» cuando el vecino en realidad dijo que el
  --      tramite le costo, y manda al area a reescribir una respuesta que
  --      estaba bien.
  select votos_no_utiles into n from public.v_conversaciones where id = v_conv;
  if n <> 2 then raise exception 'la vista conto % pulgares abajo, esperaba 2', n; end if;

  select votos_respuesta_mala into n from public.v_conversaciones where id = v_conv;
  if n <> 1 then raise exception 'la vista conto % respuestas malas, esperaba 1', n; end if;

  select votos_tramite_dificil into n from public.v_conversaciones where id = v_conv;
  if n <> 1 then raise exception 'la vista conto % tramites dificiles, esperaba 1', n; end if;

  -- 17 - Un `sobre` inventado se rechaza. Es la misma defensa que el voto
  --      invalido: si entra basura, la separacion de arriba deja de valer.
  begin
    perform public.registrar_voto(v_conv, 'util', v_mensaje, 'mas_o_menos');
    raise exception 'acepto un «sobre» invalido';
  exception when others then
    if sqlerrm not like 'sobre invalido%' then raise; end if;
  end;

  -- 18 - Y sin el cuarto argumento sigue siendo 'respuesta'. Esto es lo que
  --      hace que el bot ya desplegado no se rompa cuando se aplica la 028:
  --      todas sus llamadas de hoy pasan tres argumentos.
  --
  --      Tiene que ir contra un mensaje SIN VOTAR. La version anterior re-votaba
  --      `v_mensaje` —que arriba quedo como 'tramite'— y funcionaba solo porque
  --      el voto se sobreescribia. Con el bloqueo de la 029 ese camino no toca
  --      nada, la fila sigue diciendo 'tramite', y el check habria fallado
  --      culpando al default en vez de a si mismo.
  insert into public.mensajes (conversacion_id, direccion, texto, origen_respuesta)
  values (v_conv, 'saliente', 'Los Puntos Verdes abren de 8 a 20.', 'faq')
  returning id into v_mensaje2;

  v_res := public.registrar_voto(v_conv, 'util', v_mensaje2);
  if (v_res->>'id') is null then raise exception 'no se registro el voto de control'; end if;
  select sobre into v_texto from public.valoraciones where mensaje_id = v_mensaje2;
  if v_texto <> 'respuesta' then
    raise exception 'el default de `sobre` quedo en «%» en vez de respuesta', v_texto;
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.conversaciones where id in (v_conv, v_otra, v_conv_v);
  delete from public.personal_panel where usuario_id = v_op;
  delete from auth.users where id = v_op;
end $$;
\echo '   OK: el voto va contra la respuesta, se cierra con el primer toque, y el panel no lo modifica'

-- ---------------------------------------------------------------------------
-- BLOQUE O - La superficie ejecutable: ninguna funcion abierta a la clave publica
-- ---------------------------------------------------------------------------
-- Este bloque existe porque el arnes NO PODIA ver este problema, y la razon vale
-- dejarla escrita: `roles_supabase.sql` daba EXECUTE sobre funciones solo a
-- `service_role`, mientras Supabase se lo da a los tres roles. La condicion que
-- produjo el hallazgo real —ocho funciones de `public` ejecutables con la clave
-- publica, que esta en el JavaScript del panel— no podia darse en esta base. Una
-- prueba habria pasado por falta de privilegio y no porque la proteccion
-- funcionara.
--
-- Es exactamente el error que el arnes ya habia cometido con las TABLAS y que su
-- propio comentario advierte. Corregido el stub, este bloque mide algo.
--
-- Verificado que detecta: sin la migracion 025, la vista devuelve 8 alertas.
\echo ' O. Funciones: ninguna abierta a la clave publica'

do $$
declare
  v_abiertas text;
  n int;
begin
  -- 1 - La vista existe. Sin ella no hay deteccion, y un bloque que no encuentra
  --     nada porque la vista falta es peor que no tener el bloque.
  if to_regclass('public.v_auditoria_funciones') is null then
    raise exception 'falta v_auditoria_funciones: la 024 no se aplico';
  end if;

  -- 2 - Y audita algo. Si el filtro de extensiones se pasara de largo, la vista
  --     devolveria cero filas y este bloque pasaria sin mirar nada.
  select count(*) into n from public.v_auditoria_funciones;
  if n < 15 then
    raise exception 'v_auditoria_funciones solo ve % funciones: el filtro esta mal', n;
  end if;

  -- 3 - EL ASERTO. Cero alertas: cualquier funcion nueva que quede ejecutable por
  --     la clave publica hace fallar esto.
  select string_agg(nombre || ' (' || left(alerta, 40) || ')', ', ' order by nombre)
    into v_abiertas
    from public.v_auditoria_funciones
   where alerta is not null;

  if v_abiertas is not null then
    raise exception 'funciones abiertas a la clave publica: %', v_abiertas;
  end if;

  -- 4 - Las DOS que SI tienen que estar abiertas siguen abiertas. Es el otro lado
  --     del aserto anterior: un revoke masivo las cerraria y dejaria a TODO el
  --     mundo afuera del panel, y la vista no lo diria porque estan exceptuadas
  --     por nombre.
  select count(*) into n
    from public.v_auditoria_funciones
   where nombre in ('es_personal_panel', 'es_admin_panel')
     and ejecutable_por_anon;
  if n <> 2 then
    raise exception
      'es_personal_panel y es_admin_panel tienen que ser ejecutables por anon: Postgres las evalua al aplicar RLS. Abiertas: % de 2', n;
  end if;

  -- 5 - Y que de verdad se puedan llamar como `authenticated`, que es lo que pasa
  --     en cada consulta del panel. El punto 4 lee el ACL; esto lo ejecuta.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  perform public.es_personal_panel();
  perform public.es_admin_panel();
  reset role;

  -- 6 - Las internas quedaron solo para service_role. Se prueba por el EFECTO:
  --     como `authenticated`, llamar a una tiene que dar error de permiso.
  set local role authenticated;
  begin
    perform public.tomar_trabajo('worker-prueba');
    reset role;
    raise exception 'authenticated pudo llamar a tomar_trabajo: la 025 no cerro nada';
  exception
    when insufficient_privilege then null;   -- lo esperado
  end;
  reset role;

  -- 7 - Y el worker si puede, que es el otro lado. Sin esto, un revoke de mas
  --     dejaria la cola muerta y el bloque pasaria igual.
  set local role service_role;
  perform public.tomar_trabajo('worker-prueba');
  reset role;
end $$;
\echo '   OK: cero funciones abiertas, RLS conserva las suyas y el worker la cola'

-- ---------------------------------------------------------------------------
-- BLOQUE P - El padron: nadie se bloquea a si mismo (027)
-- ---------------------------------------------------------------------------
-- Se verifico ANTES de escribir el trigger que las tres operaciones pasaban: el
-- unico admin podia bajarse el rol, darse de baja y borrarse, y despues no podia
-- revertir ninguna. El panel quedaba sin nadie que lo administre.
--
-- Este bloque prueba las DOS direcciones, y la segunda importa tanto como la
-- primera: que el trigger bloquee, y que NO bloquee al SQL Editor. Un trigger
-- que cierra la puerta de salida convierte un problema recuperable en uno que
-- necesita soporte de Supabase.
\echo ' P. El padron: nadie se saca a si mismo el acceso'

do $$
declare
  v_admin uuid := '11111111-aaaa-1111-aaaa-111111111111';
  v_otro  uuid := '22222222-bbbb-2222-bbbb-222222222222';
  n int;
  v_rol text;
  v_activo boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin, 'admin.padron@smt.gob.ar', now()),
    (v_otro,  'otro.padron@smt.gob.ar',  now())
  on conflict (id) do nothing;
  insert into public.personal_panel (usuario_id, correo, nombre, rol) values
    (v_admin, 'admin.padron@smt.gob.ar', 'Admin', 'admin'),
    (v_otro,  'otro.padron@smt.gob.ar',  'Otro',  'operador')
  on conflict (usuario_id) do update set rol = excluded.rol, activo = true;

  -- 1 - No puede bajarse el rol a si mismo.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin
    update public.personal_panel set rol = 'operador' where usuario_id = v_admin;
    reset role;
    raise exception 'el admin se bajo el rol a si mismo: el panel puede quedar sin administrador';
  exception when insufficient_privilege then null;
  end;
  reset role;
  select rol into v_rol from public.personal_panel where usuario_id = v_admin;
  if v_rol <> 'admin' then raise exception 'el rol cambio igual: quedo en «%»', v_rol; end if;

  -- 2 - No puede darse de baja a si mismo.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin
    update public.personal_panel set activo = false where usuario_id = v_admin;
    reset role;
    raise exception 'el admin se dio de baja a si mismo';
  exception when insufficient_privilege then null;
  end;
  reset role;
  select activo into v_activo from public.personal_panel where usuario_id = v_admin;
  if not v_activo then raise exception 'la baja se aplico igual'; end if;

  -- 3 - No puede borrarse a si mismo.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin
    delete from public.personal_panel where usuario_id = v_admin;
    reset role;
    raise exception 'el admin se borro a si mismo';
  exception when insufficient_privilege then null;
  end;
  reset role;
  select count(*) into n from public.personal_panel where usuario_id = v_admin;
  if n <> 1 then raise exception 'la fila del admin desaparecio'; end if;

  -- 4 - LO QUE SI TIENE QUE PODER: cambiarle el rol a OTRO. Sin esto el trigger
  --     seria una tranca y no una guarda: la pantalla no serviria para nada.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  update public.personal_panel set rol = 'supervisor' where usuario_id = v_otro;
  reset role;
  select rol into v_rol from public.personal_panel where usuario_id = v_otro;
  if v_rol <> 'supervisor' then
    raise exception 'un admin no pudo cambiarle el rol a otro: la pantalla no sirve';
  end if;

  -- 5 - Y darlo de baja.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  update public.personal_panel set activo = false where usuario_id = v_otro;
  reset role;
  select activo into v_activo from public.personal_panel where usuario_id = v_otro;
  if v_activo then raise exception 'un admin no pudo dar de baja a otro'; end if;

  -- 6 - Editarse el NOMBRE propio si se puede. Nadie se bloquea corrigiendo su
  --     apellido, y prohibirlo seria una guarda de mas.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  update public.personal_panel set nombre = 'Admin Corregido' where usuario_id = v_admin;
  reset role;

  -- 7 - LA PUERTA DE SALIDA. Con service_role, `auth.uid()` es null y el trigger
  --     no dispara. Es lo que permite arreglar un bloqueo desde el SQL Editor.
  --     Si esto fallara, el trigger habria convertido un problema recuperable en
  --     uno que necesita soporte de Supabase.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
  update public.personal_panel set rol = 'operador' where usuario_id = v_admin;
  reset role;
  select rol into v_rol from public.personal_panel where usuario_id = v_admin;
  if v_rol <> 'operador' then
    raise exception 'service_role no pudo cambiar el rol: se cerro la puerta de salida';
  end if;
  update public.personal_panel set rol = 'admin' where usuario_id = v_admin;

  -- 8 - `cuentas_sin_padron`: resuelve correo -> cuenta, y SOLO para un admin.
  insert into auth.users (id, email, email_confirmed_at) values
    ('33333333-cccc-3333-cccc-333333333333', 'nuevo.sin.padron@smt.gob.ar', now())
  on conflict (id) do nothing;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  select count(*) into n from public.cuentas_sin_padron()
   where correo = 'nuevo.sin.padron@smt.gob.ar';
  if n <> 1 then raise exception 'cuentas_sin_padron no devolvio la cuenta nueva'; end if;

  -- Y NO devuelve a los que ya estan en el padron: es lo que la hace inutil
  -- para enumerar usuarios.
  select count(*) into n from public.cuentas_sin_padron() where usuario_id = v_admin;
  if n <> 0 then raise exception 'cuentas_sin_padron devolvio a alguien que ya esta en el padron'; end if;

  -- 9 - Un operador NO la puede llamar: ahi salen correos.
  --
  -- El claim se limpia para PREPARAR y se pone para MEDIR, igual que en el
  -- bloque J: con el claim puesto, este update seria `v_otro` reactivandose a si
  -- mismo y el trigger lo bloquea. Es preparacion, no una accion de usuario.
  perform set_config('request.jwt.claim.sub', '', true);
  update public.personal_panel set activo = true, rol = 'operador' where usuario_id = v_otro;
  perform set_config('request.jwt.claim.sub', v_otro::text, true);
  begin
    perform public.cuentas_sin_padron();
    raise exception 'un operador pudo listar las cuentas de auth.users';
  exception when insufficient_privilege then null;
  end;

  -- 10 - Y NO devuelve nada que permita autenticarse. Se comprueba sobre la
  --      firma: si alguien agrega una columna sensible, esto falla.
  select count(*) into n
    from information_schema.routines r
    join information_schema.parameters p
      on p.specific_name = r.specific_name
   where r.routine_schema = 'public'
     and r.routine_name = 'cuentas_sin_padron'
     and p.parameter_mode = 'OUT'
     and p.parameter_name in ('encrypted_password','confirmation_token','recovery_token',
                              'raw_app_meta_data','raw_user_meta_data','phone');
  if n > 0 then
    raise exception 'cuentas_sin_padron devuelve % columna(s) sensible(s) de auth.users', n;
  end if;

  -- 11 - Un correo activo, una sola fila.
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    insert into public.personal_panel (usuario_id, correo, nombre, rol, activo)
    values ('44444444-dddd-4444-dddd-444444444444', 'ADMIN.PADRON@smt.gob.ar', 'Duplicado', 'operador', true);
    raise exception 'entraron dos filas activas con el mismo correo';
  exception when unique_violation then null;
  end;

  -- Limpieza. El claim se limpia primero: con `v_otro` puesto, este DELETE
  -- incluiria su propia fila y el trigger lo bloquearia. Ya me paso una vez.
  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.personal_panel
   where usuario_id in (v_admin, v_otro, '44444444-dddd-4444-dddd-444444444444');
  delete from auth.users
   where id in (v_admin, v_otro, '33333333-cccc-3333-cccc-333333333333',
                '44444444-dddd-4444-dddd-444444444444');
end $$;
\echo '   OK: nadie se autobloquea, el SQL Editor sigue pudiendo arreglar, y solo un admin ve las cuentas'

\echo '=============================================='
\echo ' TODAS LAS PRUEBAS FUNCIONALES PASARON'
\echo '=============================================='
