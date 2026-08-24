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
  update public.personal_panel set activo = false where usuario_id = v_uid;
  if public.es_personal_panel() then
    raise exception 'un usuario dado de baja siguio teniendo acceso';
  end if;

  -- Un operador no es admin: no puede tocar el padron.
  update public.personal_panel set activo = true, rol = 'operador' where usuario_id = v_uid;
  if public.es_admin_panel() then
    raise exception 'un operador quedo con permisos de admin';
  end if;

  update public.personal_panel set rol = 'admin' where usuario_id = v_uid;
  if not public.es_admin_panel() then
    raise exception 'un admin no fue reconocido como admin';
  end if;

  delete from public.personal_panel where usuario_id = v_uid;
  delete from auth.users where id = v_uid;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
\echo '   OK: el padron habilita, la baja quita el acceso y el rol se respeta'

\echo '=============================================='
\echo ' TODAS LAS PRUEBAS FUNCIONALES PASARON'
\echo '=============================================='
