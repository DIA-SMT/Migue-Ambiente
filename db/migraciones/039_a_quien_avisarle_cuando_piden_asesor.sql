-- ===========================================================================
-- 039 · A quién avisarle cuando un vecino pide hablar con una persona
-- ===========================================================================
-- Hoy, cuando alguien pide un asesor, el bot registra el pedido en
-- `alertas_asesor` y le contesta que ya avisó. Pero no avisa a nadie: el único
-- aviso que existe es el contador de la barra del panel, y ése sólo sirve si
-- alguien ya lo tiene abierto. El vecino se va con una promesa y del otro lado
-- puede no haber nadie mirando.
--
-- Esta migración siembra a QUIÉN hay que avisarle, y nada más. El envío todavía
-- no existe, y no por falta de código: para escribirle a alguien que no le
-- escribió primero al bot, la Cloud API de WhatsApp exige el alta con Meta y
-- una plantilla aprobada por ellos, y el canal arranca apagado mientras falten
-- las cuatro credenciales. Sembrar la clave ahora deja que el área cargue los
-- números cuando los tenga decididos —que es un trámite de ellos, no nuestro— y
-- que el día del alta el aviso empiece a salir sin volver a tocar la base.
--
-- Por eso el panel la muestra MARCADA como no conectada, con la columna que ya
-- existe para eso. Un campo que se guarda y no hace nada, sin decirlo, es peor
-- que no tenerlo: alguien carga su número, se queda tranquilo, y el pedido
-- sigue esperando a que alguien abra el panel.
--
-- NACE VACÍA a propósito. No se siembra ningún número: cuáles son, y si sus
-- dueños aceptan recibir avisos ahí, es una decisión del área — y la política de
-- mensajería de Meta además exige ese consentimiento documentado.
--
-- El formato que se guarda son los DÍGITOS en formato internacional
-- (5493812067777), que es lo que pide la API para mandar. El área los escribe
-- como los tiene en la agenda y el panel los normaliza al guardar, con el mismo
-- parseo que ya usa `enlace_migue`: ahí están resueltas las tres trampas del
-- formato argentino —el 9 que no se marca, el 15 que no va, el 0 de larga
-- distancia—.
-- ===========================================================================

insert into public.configuracion (clave, valor, descripcion, categoria) values
  ('asesor_avisar_a', '[]'::jsonb,
   'Telefonos del area a los que avisarle cuando un vecino pide hablar con una '
   'persona, en formato internacional (5493812067777). Los carga el panel en '
   'Reglas, uno por linea, y los normaliza al guardar. Vacio significa no '
   'avisarle a nadie: el pedido queda igual en «Pedidos de asesor», que es '
   'donde vive de verdad. TODAVIA NO SALE NINGUN AVISO: falta el alta de '
   'WhatsApp con Meta y una plantilla aprobada por ellos.',
   'negocio')
on conflict (clave) do nothing;
