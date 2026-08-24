/**
 * Cliente de Supabase para el navegador.
 *
 * Está en su propio archivo Y ESO NO ES ORDEN, ES NECESIDAD: el cliente de
 * servidor importa `next/headers`, que sólo existe del lado del servidor. Si
 * los dos vivieran en el mismo módulo, un componente marcado `"use client"`
 * arrastraría `next/headers` al bundle del navegador y el build falla con
 * «You're importing a component that needs next/headers».
 *
 * Usa la clave ANÓNIMA, que es pública por diseño y viaja en el bundle. Lo que
 * limita a cada persona a lo que puede ver es Row Level Security, no este
 * código. Ver db/migraciones/017_cierra_acceso_autenticado.sql.
 */
import { createBrowserClient } from "@supabase/ssr";
import { configuracionSupabase } from "./configuracion.ts";

export function clienteNavegador() {
  const { url, anon } = configuracionSupabase();
  return createBrowserClient(url, anon);
}
