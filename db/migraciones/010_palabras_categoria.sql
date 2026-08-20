-- ===========================================================================
-- 010 · Palabras clave por categoría de residuo
-- ===========================================================================
-- El flujo A tiene que decidir si «tengo unos ladrillos y revoque» es
-- escombros, poda o voluminosos, para saber contra qué límite compararlo.
--
-- Las palabras van en la tabla y no en el código por el mismo motivo que todo
-- lo demás: el vocabulario real de los vecinos es local y cambia. Alguien de
-- Ambiente va a querer agregar «changuito», «carretilla» o el nombre de un
-- material que acá no figura, sin esperar un deploy.
-- ===========================================================================

alter table public.limites_volumen
  add column if not exists palabras text[] not null default '{}';

comment on column public.limites_volumen.palabras is
  'Palabras que identifican la categoría en el texto del vecino. Se comparan normalizadas (sin acentos, minúsculas) y por palabra completa.';

-- Se usa `where palabras = '{}'` para no pisar el vocabulario que Ambiente
-- haya ampliado desde el panel.
update public.limites_volumen set palabras = array[
  'escombro','escombros','material de construccion','ladrillo','ladrillos',
  'cemento','arena','cascote','cascotes','revoque','mamposteria','obra',
  'demolicion','baldosa','baldosas','mortero','hormigon'
] where categoria = 'escombros' and palabras = '{}';

update public.limites_volumen set palabras = array[
  'poda','rama','ramas','pasto','cesped','hoja','hojas','arbusto','arbustos',
  'planta','plantas','yuyo','yuyos','maleza','follaje','ligustro','enredadera'
] where categoria = 'poda' and palabras = '{}';

update public.limites_volumen set palabras = array[
  'mueble','muebles','sillon','sillones','silla','sillas','colchon','colchones',
  'heladera','ropero','placard','mesa','mesas','chatarra','electrodomestico',
  'electrodomesticos','tarima','tarimas','voluminoso','voluminosos','somier',
  'lavarropas','televisor','estufa','cocina','bacha','inodoro'
] where categoria = 'voluminosos' and palabras = '{}';
