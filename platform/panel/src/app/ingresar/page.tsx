"use client";

import { useState } from "react";
import { clienteNavegador } from "@/lib/supabase-navegador";

/**
 * Ingreso al panel por enlace de acceso.
 *
 * Enlace por correo y no contraseña, a propósito: el registro público en
 * Supabase Auth está CERRADO, así que las cuentas las crea un administrador por
 * invitación. Con ese modelo, una contraseña es una credencial más que
 * administrar, recordar y rotar, para el mismo resultado.
 *
 * El mensaje de respuesta es el MISMO exista o no la cuenta. Si dijera «esa
 * dirección no está registrada», cualquiera podría averiguar quién trabaja en
 * el municipio probando direcciones.
 */
export default function Ingresar() {
  const [correo, setCorreo] = useState("");
  const [estado, setEstado] = useState<"quieto" | "enviando" | "enviado" | "error">("quieto");
  const [detalle, setDetalle] = useState("");

  async function enviar(evento: React.FormEvent) {
    evento.preventDefault();
    setEstado("enviando");
    setDetalle("");

    try {
      const supabase = clienteNavegador();
      const volver = new URLSearchParams(window.location.search).get("volver") ?? "/";

      const { error } = await supabase.auth.signInWithOtp({
        email: correo.trim(),
        options: {
          // No se crean cuentas desde acá. El alta es por invitación de un
          // administrador; sin esto, pedir el enlace crearía el usuario.
          shouldCreateUser: false,
          emailRedirectTo:
            `${window.location.origin}/auth/callback?volver=${encodeURIComponent(volver)}`,
        },
      });

      // Un error de credenciales tampoco se distingue: mismo mensaje. Sólo se
      // reporta lo que es claramente un problema técnico.
      if (error && !/not found|signups not allowed|invalid/i.test(error.message)) {
        setEstado("error");
        setDetalle(error.message);
        return;
      }
      setEstado("enviado");
    } catch (error) {
      setEstado("error");
      setDetalle(error instanceof Error ? error.message : String(error));
    }
  }

  if (estado === "enviado") {
    return (
      <main>
        <h1>Revisá tu correo</h1>
        <p>
          Si <strong>{correo}</strong> está habilitada para el panel, te llega un enlace de
          acceso. Vence en una hora.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Panel de Migue Ambiente</h1>
      <form onSubmit={enviar}>
        <label htmlFor="correo">Correo institucional</label>
        <input
          id="correo"
          name="correo"
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={correo}
          onChange={(e) => setCorreo(e.target.value)}
          placeholder="nombre@smt.gob.ar"
        />
        <button type="submit" disabled={estado === "enviando" || correo.trim() === ""}>
          {estado === "enviando" ? "Enviando…" : "Enviarme el enlace"}
        </button>
      </form>

      {estado === "error" && (
        <p role="alert">No se pudo enviar el enlace: {detalle}</p>
      )}

      <p>El acceso lo habilita un administrador. No hay registro abierto.</p>
    </main>
  );
}
