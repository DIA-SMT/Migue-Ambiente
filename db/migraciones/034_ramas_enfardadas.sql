-- ---------------------------------------------------------------------------
-- 034 · Las ramas enfardadas van con los voluminosos, no con la poda
--
-- LO QUE DICE LA ESPECIFICACIÓN MVP. El paso A3 lista tres opciones y la
-- tercera es «Otros (Muebles, chatarra, ramas enfardadas)», con LIMITE_OTROS =
-- 1 m³. Las ramas sueltas, en cambio, son poda: hasta 10 bolsas.
--
-- LO QUE PASABA. «ramas enfardadas» no estaba en el vocabulario de voluminosos,
-- así que el detector sólo veía «rama» y «ramas» —que son de poda— y el pedido
-- se validaba contra 10 bolsas en vez de contra 1 m³. Un fardo de ramas no se
-- mide en bolsas.
--
-- Se agregan al vocabulario en vez de al código, como el resto: el vecino de
-- Tucumán va a decirlo de formas que no están acá y el área las suma desde el
-- panel, sin deploy.
--
-- El desempate lo resuelve `detectarCategoria`: cuando dos categorías empatan
-- en cantidad de coincidencias y una de ellas coincidió por una FRASE y la otra
-- por una palabra suelta, gana la frase. «ramas enfardadas» es evidencia más
-- fuerte que «ramas».
--
-- Idempotente: sólo agrega lo que falta, sin tocar lo que el área haya cargado.
-- ---------------------------------------------------------------------------

update public.limites_volumen
   set palabras = (
     select array_agg(distinct p order by p)
       from unnest(
         palabras || array[
           'rama enfardada', 'ramas enfardadas', 'enfardada', 'enfardadas',
           'enfardado', 'enfardados', 'fardo', 'fardos',
           -- Con «ramas» adentro hacen falta las frases: si no, «un fardo de
           -- ramas» le da dos coincidencias a poda —«rama» y «ramas»— contra una
           -- sola de voluminosos, y el pedido se mide contra 10 bolsas. Un metro
           -- cúbico de fardo excede ese límite, así que al vecino se le negaría
           -- un servicio al que tiene derecho.
           'fardo de ramas', 'fardos de ramas'
         ]
       ) as p
   )
 where categoria = 'voluminosos';

-- El peso máximo por bolsa deja de ser sólo un factor de conversión: desde esta
-- versión, `validarVolumen` rechaza el pedido cuando el vecino declara bolsas
-- más pesadas que el límite. La spec lo pide desde el principio —«> 5 bolsas O
-- > 15 kg c/u»— y sólo se validaba la primera mitad, así que «5 bolsas de 30
-- kilos» —150 kg— entraba como si estuviera dentro del servicio gratuito.
--
-- No hace falta cambiar ningún dato: los 15 kg ya estaban cargados en la fila
-- de escombros. Queda anotado en la descripción para que se entienda qué hace
-- ese número, que hasta ahora no se veía en ninguna parte.

comment on column public.limites_volumen.peso_max_bolsa_kg is
  'Kilos maximos por bolsa. Sirve para dos cosas: convertir cuando el vecino declara en kilos, y rechazar el pedido si declara bolsas mas pesadas que esto (la spec pide «> 5 bolsas O > 15 kg c/u»). Vacio = no se controla el peso por bolsa.';
