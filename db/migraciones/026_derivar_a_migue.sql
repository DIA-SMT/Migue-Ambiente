-- ===========================================================================
-- 026 · Derivar a Migue lo que no es de Ambiente
-- ===========================================================================
-- CAMBIO DE ALCANCE, decidido con el área. Este bot es de la Secretaría de
-- Ambiente y sólo de ella: el área define qué contesta, carga sus preguntas
-- frecuentes y sus documentos. Todo lo demás se deriva a Migue, el asistente
-- general del municipio, que atiende en otro número.
--
-- Eso arregla el peor comportamiento que tenía el bot. Hasta ahora, cuando no
-- entendía o no sabía, mostraba el menú y esperaba — y si el vecino insistía,
-- volvía a mostrar el menú. Un bucle sin salida. Con un destino real, «no sé»
-- deja de ser un fracaso y pasa a ser un desvío.
--
-- LA REGLA, tal como la definió el área: el menú UNA vez, y si el vecino insiste
-- con algo que sigue sin encajar, se deriva.
--
-- No es derivación directa a propósito, y el motivo está en los datos: de los
-- tres mensajes reales que cayeron en el menú, uno era `/start`, otro un número
-- de menú, y el tercero un reclamo que el clasificador leyó mal. Con derivación
-- al primer fallo, ese tercer vecino habría sido mandado a otro número por un
-- error NUESTRO. El menú actúa de red: si el vecino elige una opción, era
-- nuestro y lo atendemos.
--
-- LAS 7 REGLAS DE EXCLUSIÓN NO CAMBIAN. Gas va a Gasnor, agua al SAT, y así.
-- Son urgencias o temas con un destino conocido, y meterles un salto de más
-- cuesta tiempo justo donde el tiempo importa: una fuga de gas no puede ir a otro
-- bot que va a volver a preguntar. Migue queda para lo que NO tiene destino
-- conocido.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · A dónde se deriva
-- ---------------------------------------------------------------------------
-- Va en `configuracion` y no en el código porque es un dato del municipio que
-- puede cambiar, y porque el área tiene que poder corregirlo sin un deploy.
--
-- ARRANCA VACÍO A PROPÓSITO. Mientras esté vacío el bot NO deriva: vuelve a
-- mostrar el menú, que es el comportamiento de hoy. Es preferible a mandarle al
-- vecino «escribile a Migue» sin decirle a dónde, que es lo que pasaría con un
-- valor de ejemplo mal puesto. Se carga desde Reglas.
insert into public.configuracion (clave, valor, descripcion) values
  ('enlace_migue',
   '""',
   'Enlace o numero de Migue, el asistente general del municipio, a donde se deriva lo que no es de Ambiente. Formato recomendado: https://wa.me/549381XXXXXXX. VACIO = el bot no deriva y vuelve a mostrar el menu.'),

  ('derivar_tras_intentos',
   '1',
   'Cuantas veces se muestra el menu antes de derivar. 1 = una vez el menu, y si el vecino insiste se deriva. 0 = deriva en el primer mensaje que no encaje.')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- 2 · Lo que le dice al vecino
-- ---------------------------------------------------------------------------
-- Con marcador `{migue}`, que se reemplaza por el enlace. Es el tercer texto del
-- proyecto que interpola algo, y la lista de qué texto acepta qué marcador vive
-- en el dominio (`marcadores.ts`), no acá: es una propiedad del código —qué paso
-- llama a `interpolar`— y una copia en la base se desincronizaría.
insert into public.textos_bot (clave, texto, descripcion, opcional) values
  ('derivar_a_migue',
   E'Eso no lo atiende la Secretaría de Ambiente, pero no te quedes sin respuesta: escribile a Migue, el asistente general de la Municipalidad.\n\n{migue}\n\nSi lo que necesitás es algo de Ambiente —retiro de residuos, un reclamo de recolección, Puntos Verdes o los programas— contame de nuevo y lo vemos.',
   'Se envia cuando el vecino insiste con algo que no es de Ambiente. El marcador {migue} se reemplaza por el enlace cargado en Reglas. Si se vacia, el bot no deriva: vuelve a mostrar el menu.',
   true)
on conflict (clave) do update
  set descripcion = excluded.descripcion,
      opcional = excluded.opcional;

-- ---------------------------------------------------------------------------
-- 3 · Qué se registra cuando se deriva
-- ---------------------------------------------------------------------------
-- Se usa el motivo `fuera_de_alcance`, que YA existe en el CHECK de
-- `sin_respuesta` desde la 004 y que hasta hoy nadie escribía. No hace falta un
-- motivo nuevo: es exactamente lo que significa.
--
-- Y esto cambia para qué sirve la pantalla «Sin responder». Antes una fila era
-- «hay que escribir esta respuesta». Ahora una fila con motivo
-- `fuera_de_alcance` es una pregunta distinta, y más útil:
--
--   «¿esto era nuestro y lo derivamos mal, o estuvo bien derivado?»
--
-- Las dos tienen arreglos opuestos: escribir una respuesta, o no hacer nada. El
-- panel las separa.
comment on column public.sin_respuesta.motivo is
  'sin_coincidencia = el buscador no encontro nada, falta material. confianza_baja = encontro algo flojo. fuera_de_alcance = se DERIVO a Migue; la pregunta para el area es si estuvo bien derivado o si era nuestro. error_modelo = fallo el proveedor, no es un problema de contenido.';

-- ---------------------------------------------------------------------------
-- 4 · Cuántas derivamos, y cuántas eran nuestras
-- ---------------------------------------------------------------------------
-- La métrica que importa de este cambio no es cuántas derivaciones hubo: es
-- cuántas de esas el área despues resolvió escribiendo una respuesta. Cada una
-- de esas es un vecino al que mandamos a otro número por algo que sí era
-- nuestro.
--
-- Se calcula sobre `sin_respuesta`, que ya guarda el vinculo a la respuesta con
-- la que se resolvio (021).
drop view if exists public.v_derivaciones;

create view public.v_derivaciones
with (security_invoker = true) as
  select date_trunc('day', s.creado_en)::date            as dia,
         count(*)                                        as derivadas,
         count(*) filter (where s.estado = 'resuelta')    as eran_nuestras,
         count(*) filter (where s.estado = 'descartada')  as bien_derivadas,
         count(*) filter (where s.estado = 'pendiente')   as sin_revisar
    from public.sin_respuesta s
   where s.motivo = 'fuera_de_alcance'
   group by 1
   order by 1 desc;

comment on view public.v_derivaciones is
  'Derivaciones a Migue por dia, y cuantas el area despues resolvio escribiendo una respuesta: esas eran nuestras y las derivamos mal.';

revoke all on public.v_derivaciones from public, anon;
grant select on public.v_derivaciones to authenticated, service_role;
