"use client";

/**
 * El interruptor de tema, y por qué está escrito así.
 *
 * TRES estados, no dos: claro, oscuro, y «lo que diga el sistema» —que es el
 * estado inicial y no se guarda—. Quien nunca tocó el botón ve el panel en el
 * tema de su máquina; en cuanto lo toca, su elección manda y sobrevive a los
 * reinicios.
 *
 * El botón NO decide en JavaScript qué ícono mostrar. Renderiza los dos y deja
 * que el CSS esconda el que no va, mirando `data-tema` en el `<html>` y
 * `prefers-color-scheme`. Es a propósito: el servidor no puede saber qué tema
 * tiene la máquina de quien abre la página, así que cualquier ícono elegido en
 * el render sería distinto en el servidor y en el navegador — y eso es un error
 * de hidratación. Ya nos comimos uno de esos con el `<title>` de las barras del
 * gráfico; este está evitado por construcción.
 *
 * Por el mismo motivo la etiqueta accesible es fija —«Cambiar entre tema claro y
 * oscuro»— y no «Pasar a oscuro»: describe lo que hace el botón, no el estado,
 * así que es correcta en los tres casos y no depende de nada que el servidor no
 * sepa.
 */
const CLAVE = "migue-tema";

export function Tema() {
  function alternar() {
    // Se lee en el momento del clic, no en el render: acá ya estamos en el
    // navegador y no hay nada que hidratar.
    const raiz = document.documentElement;
    const elegido = raiz.dataset["tema"];
    const oscuroAhora =
      elegido === "oscuro" ||
      (elegido === undefined && window.matchMedia("(prefers-color-scheme: dark)").matches);

    const nuevo = oscuroAhora ? "claro" : "oscuro";
    raiz.dataset["tema"] = nuevo;

    // El modo privado del navegador puede tirar en `setItem`. Si falla, el tema
    // igual cambió para esta sesión: se pierde al recargar y no pasa nada más.
    try {
      window.localStorage.setItem(CLAVE, nuevo);
    } catch {
      /* sin persistencia, pero el panel sigue andando */
    }
  }

  return (
    <button
      type="button"
      className="tema-boton"
      onClick={alternar}
      aria-label="Cambiar entre tema claro y oscuro"
      title="Cambiar entre tema claro y oscuro"
    >
      {/* Luna: se ve cuando el tema activo es el CLARO, porque es a lo que se va. */}
      <svg className="a-oscuro" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path
          d="M16.5 12.4A6.8 6.8 0 0 1 7.6 3.5a6.9 6.9 0 1 0 8.9 8.9z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      {/* Sol: se ve cuando el tema activo es el OSCURO. */}
      <svg className="a-claro" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="10" cy="10" r="3.6" />
          <path d="M10 2.2v1.9M10 15.9v1.9M2.2 10h1.9M15.9 10h1.9M4.5 4.5l1.3 1.3M14.2 14.2l1.3 1.3M15.5 4.5l-1.3 1.3M5.8 14.2l-1.3 1.3" />
        </g>
      </svg>
    </button>
  );
}
