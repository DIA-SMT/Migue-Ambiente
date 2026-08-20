# Esquema de base de datos — Migue Ambiente

Postgres sobre Supabase (proyecto `brzosohhwdicqupwqshi`, región São Paulo).

## Cómo aplicarlo

Pegá **[aplicar_todo.sql](aplicar_todo.sql)** en el SQL Editor de Supabase y ejecutá.
Es idempotente: se puede correr las veces que haga falta sin romper nada ni
duplicar semillas. Verás varios `NOTICE ... does not exist, skipping` en la
primera corrida — son los `drop if exists` sobre una base vacía, no son errores.

Ese archivo se **genera**, no se edita. Para cambiar el esquema: editá la
migración correspondiente en `migraciones/` y regenerá con

```bash
bash db/generar_aplicar_todo.sh
```

## Migraciones

| Archivo | Qué hace |
|---|---|
| `001_base.sql` | Extensiones, configuración de búsqueda en español sin acentos, tablas `configuracion` y `textos_bot` |
| `002_conocimiento.sql` | `documentos`, `fragmentos`, `faqs`, `respuestas_fijas` + índices FTS y trigram |
| `003_reglas.sql` | `limites_volumen`, `reglas_exclusion`, `puntos_verdes`, `zonas_recoleccion` |
| `004_conversaciones.sql` | `conversaciones`, `mensajes`, `sin_respuesta` |
| `005_transaccional.sql` | Extiende `tickets` y `program_requests` (preexistentes) |
| `006_trabajos.sql` | Cola panel → worker, con toma atómica |
| `007_rls.sql` | RLS con denegación por defecto en las 16 tablas + vista de auditoría |
| `008_semillas.sql` | Reglas y textos institucionales de la Especificación MVP |

## Decisiones que conviene conocer

**Búsqueda sin acentos.** Hay una configuración de búsqueda propia,
`es_sin_acentos`, que combina `unaccent` con el stemmer español. Sin eso, un
vecino que escribe "recoleccion organico" no encuentra "recolección orgánico",
que es exactamente cómo se escribe en un chat. Verificado: la consulta sin
tildes encuentra el texto con tildes, y `reciclable` encuentra `reciclables`.

**Las etiquetas de FAQ no están en el `tsvector`.** `array_to_string()` es
`STABLE`, no `IMMUTABLE`, y Postgres rechaza la columna generada. Se indexan
aparte con GIN sobre el array, que además habilita búsqueda exacta por etiqueta.

**`setweight` en las FAQs.** La pregunta pesa `'A'` y la respuesta `'B'`, así una
coincidencia en la pregunta rankea por encima de una mención suelta en el cuerpo.
Medido: 0.608 contra 0.243.

**`faqs` y `respuestas_fijas` son cosas distintas.** Una FAQ es material que el
modelo lee para redactar. Una respuesta fija se envía **textual, sin pasar por el
modelo** — es la herramienta para cuando la redacción institucional no es
negociable y no se puede permitir que el modelo la parafrasee.

**Reglas de negocio como datos.** Ni un límite, plazo ni texto al vecino vive en
el código. Si un operador necesita esperar un deploy para corregir un límite de
bolsas, el sistema falló.

**RLS con denegación por defecto.** El relevamiento encontró que con la clave
`anon` (pública, va en el JS del navegador) se leían nombre, teléfono y dirección
de vecinos reales. Ahora las 16 tablas tienen RLS y ningún acceso `anon`.
Para auditar en cualquier momento:

```sql
select * from public.v_auditoria_rls where rls_activo = false or 'anon' = any(roles_con_acceso);
```

Debe devolver cero filas. **Toda tabla nueva se crea con RLS activo.**

**Borrado de datos personales no pasa por el panel.** Las tablas con datos de
vecinos permiten `select` y `update` a `authenticated`, pero no `delete`: son el
respaldo documental de un reclamo municipal. Una supresión se hace con
`service_role` y queda registrada.

**Idempotencia.** Postgres no tiene `CREATE TRIGGER IF NOT EXISTS`, así que cada
trigger va precedido de su `drop trigger if exists`. Lo mismo con las
constraints de `005`. Verificado en tres pasadas consecutivas.

## Pruebas

`pruebas/` corre contra un Postgres desechable, **nunca contra Supabase**:

- `roles_supabase.sql` — crea `anon`, `authenticated`, `service_role`, que un
  Postgres común no tiene y que las políticas de `007` necesitan
- `000_stub_tablas_legado.sql` — réplica de `tickets` y `program_requests` para
  poder validar la migración `005` que las altera
- `010_pruebas_funcionales.sql` — verifica semillas sin duplicar, FTS sin
  acentos, stemming, ranking por `setweight`, tolerancia a errores de tipeo,
  toma atómica de la cola con dos workers, recuperación de trabajos colgados y
  el trigger contador de mensajes

Para correrlas en la VPS:

```bash
bash db/pruebas/validar.sh
```

## Pendientes de definición de Ambiente

Cargados con un valor por defecto y marcados en la columna `descripcion`:

| Punto | Valor actual | Por qué está abierto |
|---|---|---|
| SLA | 72 hs hábiles | La spec dice 72; un borrador dice 48-72 |
| Al exceder el límite | `parcial_con_ticket` | La spec dice rechazo parcial con ticket; un borrador dice derivar sin ticket |
| Límite de poda | 10 bolsas | La spec dice 10 bolsas; un borrador agrega "o 1 m³" |
| Foto obligatoria | `true` | Los borradores preguntan si hay excepciones |
| Puntos Verdes | 3 de la spec | Falta el listado oficial con horarios y materiales por punto |
| Residuos fuera de alcance | Lista conservadora | Falta la lista oficial |
