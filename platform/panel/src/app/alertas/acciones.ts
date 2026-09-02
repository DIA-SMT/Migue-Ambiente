"use server";

/**
 * Acciones sobre los pedidos de asesor.
 *
 * Una sola: cerrar (o reabrir) la alerta. Va por la función `atender_alerta`
 * de la base y no por un UPDATE directo, a propósito: la tabla no tiene
 * política de UPDATE para el panel — una política dejaría editar el teléfono y
 * el motivo, que son palabras del vecino — y la función sella quién y cuándo
 * con `auth.uid()` y `now()`, que el cliente no puede falsear.
 */
import { revalidatePath } from "next/cache";
import { clienteServidor, personaActual } from "@/lib/supabase-servidor";

export interface Resultado {
  readonly ok: boolean;
  readonly mensaje: string;
}

export async function atenderAlerta(
  id: string,
  estado: "atendida" | "descartada" | "pendiente",
  notas?: string,
): Promise<Resultado> {
  const persona = await personaActual();
  if (!persona) return { ok: false, mensaje: "Tu cuenta no está habilitada." };

  const supabase = await clienteServidor();
  const { error } = await supabase.rpc("atender_alerta", {
    p_alerta_id: id,
    p_estado: estado,
    p_notas: notas?.trim() || null,
  });

  if (error) {
    return {
      ok: false,
      mensaje: /no autorizado|insufficient/i.test(error.message)
        ? "No tenés permiso para cerrar alertas."
        : error.message,
    };
  }

  revalidatePath("/alertas");
  return {
    ok: true,
    mensaje:
      estado === "atendida"
        ? "Marcada como atendida."
        : estado === "descartada"
          ? "Descartada."
          : "Reabierta.",
  };
}
