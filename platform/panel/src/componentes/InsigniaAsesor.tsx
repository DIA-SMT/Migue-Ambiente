"use client";

/**
 * El contador de vecinos esperando un asesor, en la barra lateral.
 *
 * Consulta directo con el cliente del navegador y no con una server action, a
 * propósito: la seguridad es RLS —la doctrina escrita de supabase-navegador—,
 * un count-head con el JWT propio cuesta un GET a PostgREST sobre el índice
 * parcial de pendientes, y si la persona quedó fuera del padrón el count da
 * cero y el badge se esconde: falla cerrada.
 *
 * Cada 15 segundos, salteando los ticks con la pestaña oculta. Es polling y no
 * Realtime por la misma razón escrita en worker/bucle.ts: un websocket
 * permanente es un modo de falla nuevo, y para avisar que hay que devolver un
 * llamado, 15 segundos alcanzan y sobran.
 */
import { useEffect, useState } from "react";
import { clienteNavegador } from "@/lib/supabase-navegador";

const REFRESCO_MS = 15_000;

export function InsigniaAsesor() {
  const [pendientes, setPendientes] = useState<number | null>(null);

  useEffect(() => {
    const supabase = clienteNavegador();
    let vigente = true;

    async function contar() {
      const { count, error } = await supabase
        .from("alertas_asesor")
        .select("id", { count: "exact", head: true })
        .eq("estado", "pendiente");
      if (vigente && !error) setPendientes(count ?? 0);
    }

    void contar();
    const timer = setInterval(() => {
      if (!document.hidden) void contar();
    }, REFRESCO_MS);
    const alVolver = () => void contar();
    document.addEventListener("visibilitychange", alVolver);

    return () => {
      vigente = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, []);

  // Sin pendientes (o sin dato todavía) no hay nada que señalar.
  if (pendientes === null || pendientes === 0) return null;

  return (
    <span className="chip alerta insignia-asesor" aria-label={`${pendientes} vecinos esperando un asesor`}>
      {pendientes}
    </span>
  );
}
