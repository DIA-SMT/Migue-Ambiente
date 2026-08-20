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
select left(pregunta, 45) as pregunta,
       round(similarity(pregunta, 'donde llevo los numaticos')::numeric, 3) as similitud
  from public.faqs
 order by similarity(pregunta, 'donde llevo los numaticos') desc
 limit 2;

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
\echo '=============================================='
\echo ' TODAS LAS PRUEBAS FUNCIONALES PASARON'
\echo '=============================================='
