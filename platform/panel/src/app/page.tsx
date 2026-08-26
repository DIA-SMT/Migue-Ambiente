import { clienteServidor, personaActual } from "@/lib/supabase-servidor";
import { Armazon } from "@/componentes/Armazon";
import { Portada } from "./Portada";
import {
  LIMITE_FILAS,
  type ConversacionMedida,
  type Cotizacion,
  type MensajeMedido,
  type VotosDeConversacion,
} from "@/lib/metricas";

interface FilaConfig {
  clave: string;
  valor: unknown;
  actualizado_en: string | null;
  actualizado_por: string | null;
}
import type { Ticket } from "@/lib/tipos";

export const dynamic = "force-dynamic";

/**
 * La portada, que es el tablero.
 *
 * Este archivo sólo TRAE filas. Ni una cuenta: todo se calcula en `Portada` con
 * las funciones de `lib/metricas.ts`, que son las mismas que usa la pantalla de
 * Métricas. Es la misma división que ya tiene `metricas/page.tsx`, y existe para
 * que las dos pantallas no puedan decir cosas distintas sobre las mismas filas.
 *
 * Se trae todo y se agrega en TypeScript en vez de pedirle sumas a la base
 * porque los agregados de PostgREST están deshabilitados en este proyecto
 * —devuelven 400 PGRST123— y porque «cerrado» ya está definido y probado en
 * `tipos.ts`. `LIMITE_FILAS` marca dónde esto deja de ser gratis, y la pantalla
 * avisa cuando lo alcanza en vez de presentar un parcial como el total.
 */
export default async function Inicio() {
  const persona = await personaActual();

  // El middleware ya mandó al login a quien no tiene sesión. Si llegó acá sin
  // persona, es que su cuenta existe pero no está en el padrón.
  if (!persona) {
    return (
      <div className="pantalla-ingreso">
        <div className="caja-ingreso">
          <h1>Cuenta sin habilitar</h1>
          <p>
            Tu cuenta existe pero todavía no está habilitada para usar el panel. Pedile a un
            administrador que te agregue.
          </p>
        </div>
      </div>
    );
  }

  const supabase = await clienteServidor();

  const [conversaciones, mensajes, tickets, votos, sinResponder, config] = await Promise.all([
    supabase
      .from("conversaciones")
      .select(
        "id, canal, canal_usuario_id, estado, cantidad_mensajes, iniciada_en, ultima_actividad_en",
      )
      .order("iniciada_en", { ascending: false })
      .limit(LIMITE_FILAS)
      .returns<ConversacionMedida[]>(),

    supabase
      .from("mensajes")
      .select(
        "direccion, texto, media_tipo, intencion, confianza, origen_respuesta, modelo, tokens_entrada, tokens_salida, costo_usd, latencia_ms, fragmentos_citados, conversacion_id, creado_en",
      )
      .order("creado_en", { ascending: false })
      .limit(LIMITE_FILAS)
      .returns<MensajeMedido[]>(),

    supabase.from("tickets").select("*").limit(LIMITE_FILAS).returns<Ticket[]>(),

    // Los votos viven en la VISTA y no en la tabla: `v_conversaciones` los trae
    // ya repartidos entre «la respuesta fue mala» y «el trámite fue difícil»,
    // que son dos mediciones distintas. La tabla `conversaciones` no los tiene.
    supabase
      .from("v_conversaciones")
      .select("votos_utiles, votos_no_utiles, votos_respuesta_mala, votos_tramite_dificil")
      .limit(LIMITE_FILAS)
      .returns<VotosDeConversacion[]>(),

    // `head: true` no trae filas, sólo el total. Los agregados de PostgREST
    // están deshabilitados acá, pero el count exacto con filtro funciona — es
    // el mismo patrón que usa la pantalla de Conocimiento.
    supabase
      .from("v_sin_respuesta")
      .select("id", { count: "exact", head: true })
      .eq("estado", "pendiente"),

    // `actualizado_en` y `actualizado_por` hacen falta para el tipo de cambio:
    // el tablero no muestra pesos sin decir de cuándo es la cotización, y
    // `actualizado_por` en null distingue una fila sembrada por la migración de
    // una que alguien miró.
    supabase
      .from("configuracion")
      .select("clave, valor, actualizado_en, actualizado_por")
      .in("clave", ["conversacion_ventana_horas", "tipo_cambio_usd_ars"])
      .returns<FilaConfig[]>(),
  ]);

  const problema =
    conversaciones.error ??
    mensajes.error ??
    tickets.error ??
    votos.error ??
    sinResponder.error ??
    null;

  const ventanaHoras = Number(
    (config.data ?? []).find((c) => c.clave === "conversacion_ventana_horas")?.valor ?? 24,
  );

  // `valor` es jsonb: para una clave numérica llega como número, pero una fila
  // cargada a mano por SQL podría traer la cadena "1300". `Number()` cubre las
  // dos, y `convertirAPesos` descarta lo que no sea mayor que cero —incluido el
  // NaN de un texto que no es número—.
  const filaCambio = (config.data ?? []).find((c) => c.clave === "tipo_cambio_usd_ars");
  const cotizacion: Cotizacion = {
    valor: Number(filaCambio?.valor ?? 0),
    actualizadoEn: filaCambio?.actualizado_en ?? null,
    // Sembrada por la migración, `actualizado_por` queda en null. Es lo que
    // distingue una fila que nadie miró de una que alguien cargó a conciencia.
    editadaPorAlguien: (filaCambio?.actualizado_por ?? null) !== null,
  };

  return (
    <Armazon persona={persona} actual="/">
      <Portada
        persona={persona}
        ahora={new Date()}
        conversaciones={conversaciones.data ?? []}
        mensajes={mensajes.data ?? []}
        tickets={tickets.data ?? []}
        votosPorConversacion={votos.data ?? []}
        preguntasPendientes={sinResponder.count ?? 0}
        ventanaHoras={ventanaHoras}
        cotizacion={cotizacion}
        alcanzoElLimite={(mensajes.data ?? []).length >= LIMITE_FILAS}
        problema={problema?.message ?? null}
      />
    </Armazon>
  );
}
