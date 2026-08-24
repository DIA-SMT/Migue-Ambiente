-- ===========================================================================
-- 020 · Dos mensajes que estaban en el código y uno que faltaba
-- ===========================================================================
-- Salen de probar el bot de verdad:
--
--   1. Después de responder una consulta, Migue cortaba en seco. Falta
--      preguntar si sirvió o si necesita algo más, que es lo que hace que no
--      parezca una máquina expendedora de respuestas.
--
--   2. La despedida estaba escrita en el código («¡De nada! Si necesitás algo
--      más, escribime.», en nucleo/orquestador.ts). Es un mensaje que lee un
--      vecino, así que su lugar es esta tabla y no un literal: el área tiene que
--      poder ajustar el tono sin un deploy.
--
--   3. `reclamo_info_turnos` la LEE el código —reclamoRecoleccion.ts, con
--      `tieneTexto()`— y la fila nunca existió. Al no encontrarla, el bot saltea
--      esa información en silencio. Se crea vacía a propósito: vacía se
--      comporta igual que hoy, y el día que el área escriba los turnos reales
--      empieza a decirlos sin tocar código.
-- ===========================================================================

insert into public.textos_bot (clave, texto, descripcion) values
  ('seguimiento_tras_responder',
   '¿Te sirvió? Si necesitás algo más, escribime.',
   'Se envía DESPUÉS de responder una consulta, como mensaje aparte. Dejalo vacío para que el bot no pregunte nada al final.'),

  ('despedida',
   '¡De nada! Cualquier otra cosa, escribime.',
   'Cuando el vecino agradece o se despide.'),

  ('reclamo_info_turnos',
   '',
   'Turnos y días de recolección, si el área los quiere informar en el reclamo. VACÍO por defecto: así el bot no dice nada. Al escribir algo acá empieza a informarlo.')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- Por qué `seguimiento_tras_responder` puede ir vacío y `bienvenida` no
--
-- El código distingue dos formas de leer un texto:
--   `leerTexto()`   obligatorio. Si no está, devuelve «[falta texto: clave]» y
--                   eso se le envía al vecino.
--   `tieneTexto()`  opcional. Si está vacío, el bot simplemente no lo manda.
--
-- El panel necesita saber cuál es cuál para no dejar vaciar un texto
-- obligatorio. Se agrega una columna en vez de mantener la lista en el código
-- del panel, que se desincronizaría en el primer cambio.
-- ---------------------------------------------------------------------------
alter table public.textos_bot
  add column if not exists opcional boolean not null default false;

comment on column public.textos_bot.opcional is
  'true si el codigo lo lee con tieneTexto() y por lo tanto puede ir vacio. false si lo lee con leerTexto(), donde vaciarlo le enviaria «[falta texto: clave]» al vecino.';

update public.textos_bot set opcional = true
 where clave in ('seguimiento_tras_responder', 'reclamo_info_turnos', 'separa_fuera_de_avenidas');

-- ---------------------------------------------------------------------------
-- El menú deja de llevar su propia lista numerada
--
-- Ahora se envía con OPCIONES de verdad: en Telegram son botones, y si el vecino
-- escribe el número el bot lo entiende. El texto tenía una lista de cuatro ítems
-- escrita a mano, y las opciones son seis: dos listas distintas en el mismo
-- mensaje se contradicen.
--
-- Queda sólo la línea de presentación, que es lo editable. Cuando se sume
-- WhatsApp y su adaptador no pueda mostrar botones, va a ser ese adaptador el
-- que arme la lista numerada a partir de las opciones — no este texto.
--
-- Se actualiza sólo si sigue teniendo la lista vieja: si el área ya lo reescribió
-- no se le pisa el trabajo.
-- ---------------------------------------------------------------------------
update public.textos_bot
   set texto = 'Decime con qué necesitás que te ayude.'
 where clave = 'menu_principal'
   and texto like '%1. Retiro de residuos especiales%';

comment on column public.textos_bot.texto is
  'El mensaje tal como lo lee el vecino. Los marcadores {plazo}, {vencimiento}, {empresa} y {direccion} los reemplaza el bot al enviar.';
