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
delete from public.mensajes;
delete from public.conversaciones where canal_usuario_id = '123456';
delete from public.faqs where pregunta in (
  '¿Dónde puedo llevar mis neumáticos?',
  '¿Cómo separo los residuos reciclables?');
delete from public.documentos where ruta_storage = 'docs/prueba-separa.pdf';

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

\echo ''
\echo '=============================================='
\echo ' TODAS LAS PRUEBAS FUNCIONALES PASARON'
\echo '=============================================='
