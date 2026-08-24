"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clienteNavegador } from "@/lib/supabase-navegador";

/**
 * Cierra la sesión.
 *
 * Existe porque el panel se va a usar en computadoras compartidas de oficina, y
 * dejar la sesión abierta ahí es dejar los datos de vecinos a la vista del
 * siguiente que se siente.
 */
export function Salir() {
  const router = useRouter();
  const [saliendo, setSaliendo] = useState(false);

  return (
    <button
      className="chico"
      disabled={saliendo}
      onClick={async () => {
        setSaliendo(true);
        await clienteNavegador().auth.signOut();
        router.refresh();
        router.replace("/ingresar");
      }}
    >
      {saliendo ? "Saliendo…" : "Salir"}
    </button>
  );
}
