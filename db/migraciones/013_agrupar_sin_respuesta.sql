-- ===========================================================================
-- 013 · Agrupación de preguntas sin responder
-- ===========================================================================
-- `sin_respuesta` es la tabla más valiosa del sistema: cada fila es un vecino
-- que se fue sin respuesta, y el panel permite resolverla creando una FAQ.
--
-- Pero sin agrupar no sirve. Cincuenta vecinos preguntando lo mismo se ven
-- como cincuenta problemas distintos en lugar del único que son, y quien
-- revise el panel no puede saber qué conviene resolver primero.
--
-- Por qué una función en la base y no lógica en la aplicación:
--
--   1. El operador de similitud trigram (%) no se expresa bien por PostgREST.
--   2. Resolverlo en dos viajes —buscar parecida, después insertar— abre una
--      carrera: dos mensajes simultáneos con la misma pregunta no se ven entre
--      sí y crean dos filas. Acá es una sola sentencia atómica.
-- ===========================================================================

create or replace function public.agrupar_sin_respuesta(
  p_pregunta        text,
  p_motivo          text,
  p_conversacion_id uuid    default null,
  p_mensaje_id      uuid    default null,
  p_confianza       numeric default null,
  p_umbral          real    default 0.6
)
returns table (id uuid, agrupada boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existente uuid;
begin
  -- `set_limit` fija el umbral que usa el operador % en esta sesión.
  perform set_limit(p_umbral);

  -- Se busca sólo entre las PENDIENTES: una pregunta ya resuelta que vuelve a
  -- aparecer es señal de que la FAQ no alcanzó, y merece fila propia para que
  -- se vea que el arreglo no funcionó.
  select s.id into v_existente
    from public.sin_respuesta s
   where s.estado = 'pendiente'
     and s.pregunta % p_pregunta
   order by similarity(s.pregunta, p_pregunta) desc
   limit 1;

  if v_existente is not null then
    update public.sin_respuesta
       set veces_repetida = veces_repetida + 1,
           actualizado_en = now()
     where public.sin_respuesta.id = v_existente;
    return query select v_existente, true;
  end if;

  -- El INSERT va dentro de un WITH porque en plpgsql un `insert ... returning`
  -- no puede devolver filas por sí mismo dentro de una función `returns table`
  -- (falla con «query has no destination for result data»). Envolverlo hace
  -- que la sentencia externa sea un SELECT, que sí puede.
  return query
    with nueva as (
      insert into public.sin_respuesta
        (pregunta, motivo, conversacion_id, mensaje_id, confianza)
      values
        (p_pregunta, p_motivo, p_conversacion_id, p_mensaje_id, p_confianza)
      returning public.sin_respuesta.id
    )
    select nueva.id, false from nueva;
end $$;

comment on function public.agrupar_sin_respuesta is
  'Registra una pregunta sin responder agrupándola con una pendiente parecida (trigram). Atómica: evita filas duplicadas por mensajes simultáneos.';

-- El índice trigram que hace rápida la búsqueda ya existe desde la migración
-- 004 (sin_respuesta_pregunta_trigram_idx). Este índice parcial acelera el
-- filtro por estado, que es el que más se consulta desde el panel.
create index if not exists sin_respuesta_pendientes_repetidas_idx
  on public.sin_respuesta (veces_repetida desc, creado_en desc)
  where estado = 'pendiente';
