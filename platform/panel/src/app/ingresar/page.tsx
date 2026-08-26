"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clienteNavegador } from "@/lib/supabase-navegador";

/**
 * Ingreso con correo y contraseña.
 *
 * Las cuentas las crea un administrador desde Supabase (Authentication → Users
 * → Add user), con su contraseña. No hay registro abierto ni recuperación por
 * correo: si alguien pierde la contraseña, un administrador la cambia ahí mismo.
 *
 * La primera versión usaba enlace por correo, para no tener contraseñas que
 * administrar. Fue una mala elección para este caso: el enlace depende de la
 * entrega del mail y de que el Site URL de Supabase esté bien configurado, y con
 * eso mal configurado el enlace llevaba a localhost. Con contraseña hay menos
 * piezas que puedan fallar y el alta es una pantalla de Supabase.
 *
 * El mensaje de error es el MISMO exista o no la cuenta. Supabase ya devuelve un
 * «Invalid login credentials» indistinguible en los dos casos, y conviene
 * mantenerlo así: si dijera «esa dirección no está registrada», cualquiera
 * podría averiguar quién trabaja en el municipio probando direcciones.
 */
export default function Ingresar() {
  const router = useRouter();
  const [correo, setCorreo] = useState("");
  const [clave, setClave] = useState("");
  const [entrando, setEntrando] = useState(false);
  const [problema, setProblema] = useState<string | null>(null);

  async function entrar(evento: React.FormEvent) {
    evento.preventDefault();
    setEntrando(true);
    setProblema(null);

    try {
      const supabase = clienteNavegador();
      const { error } = await supabase.auth.signInWithPassword({
        email: correo.trim(),
        password: clave,
      });

      if (error) {
        setProblema(
          /invalid login credentials/i.test(error.message)
            ? "Correo o contraseña incorrectos."
            : error.message,
        );
        setEntrando(false);
        return;
      }

      // A dónde quería ir antes del login. Se valida que sea una ruta interna:
      // sin esto, un `volver=https://otro-sitio` convierte al panel en un
      // redirector abierto, útil para hacer pasar phishing por una URL del
      // municipio.
      const pedido = new URLSearchParams(window.location.search).get("volver") ?? "/";
      const destino = pedido.startsWith("/") && !pedido.startsWith("//") ? pedido : "/";

      // `refresh` antes de navegar: el middleware tiene que ver la cookie nueva,
      // y sin esto el primer render puede llegar sin sesión y rebotar al login.
      router.refresh();
      router.replace(destino);
    } catch (error) {
      setProblema(error instanceof Error ? error.message : String(error));
      setEntrando(false);
    }
  }

  return (
    <div className="caja-ingreso">
      {/* El isotipo del municipio abre la pantalla. Es la única marca que
          corresponde antes de entrar: dice de quién es este sistema, que es lo
          que alguien necesita saber antes de escribir su contraseña. Migue —el
          personaje— aparece recién adentro, en la portada. */}
      <div className="ingreso-marca">
        <img
          className="marca-muni"
          src="/marca/muni.png"
          alt="Municipalidad de San Miguel de Tucumán"
          width={84}
          height={96}
        />
        <div className="marca">
          Migue <span>Ambiente</span>
        </div>
        <p>Panel de administración</p>
      </div>

      <form onSubmit={entrar}>
        <div className="campo">
          <label htmlFor="correo">Correo</label>
          <input
            id="correo"
            name="correo"
            type="email"
            required
            autoComplete="username"
            autoFocus
            value={correo}
            onChange={(e) => setCorreo(e.target.value)}
            placeholder="nombre@smt.gob.ar"
          />
        </div>

        <div className="campo">
          <label htmlFor="clave">Contraseña</label>
          <input
            id="clave"
            name="clave"
            type="password"
            required
            autoComplete="current-password"
            value={clave}
            onChange={(e) => setClave(e.target.value)}
          />
        </div>

        {problema && (
          <div className="aviso mal" role="alert">
            {problema}
          </div>
        )}

        <button
          type="submit"
          className="primario"
          style={{ width: "100%" }}
          disabled={entrando || correo.trim() === "" || clave === ""}
        >
          {entrando ? "Entrando…" : "Entrar"}
        </button>
      </form>

      <p className="ayuda" style={{ marginTop: 20, textAlign: "center" }}>
        Las cuentas las da de alta un administrador. No hay registro abierto.
      </p>
    </div>
  );
}
