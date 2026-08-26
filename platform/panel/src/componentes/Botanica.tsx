/**
 * Los dibujos del panel: la marca de agua botánica y los iconos de la barra.
 *
 * SVG escrito a mano, sin librería de iconos. No es purismo: una librería de
 * iconos trae cientos de dibujos para usar siete, y ninguno de los siete diría
 * «retiro de residuos no habituales». Estos son pocos, están hechos para este
 * panel, y pesan lo que pesan siete trazos.
 *
 * Los iconos comparten la misma gramática —trazo de 1,6, extremos redondeados,
 * sin relleno— para que se lean como un juego y no como una colección.
 */

/**
 * Rama con hojas, para la marca de agua.
 *
 * Va muy tenue detrás de la barra lateral y recortada por su borde. La idea es
 * atmósfera: que se note que es el área de Ambiente sin que nadie se detenga a
 * mirar un dibujo. Por eso es asimétrica y sale del cuadro — una planta
 * centrada y completa se leería como ilustración decorativa.
 */
export function Hojas({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 200 200"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Tallo principal, curvado */}
      <path d="M34 196C34 150 46 104 74 68 96 40 128 20 166 8" />

      {/* Hojas del lado izquierdo del tallo */}
      <path d="M48 150c-14-6-26-2-34 8 10 10 24 12 34 4 8-6 10-14 8-22-3 4-6 8-8 10z" />
      <path d="M62 112c-16-3-28 3-34 15 12 8 26 7 34-3 6-7 6-15 3-23-2 5-2 8-3 11z" />
      <path d="M84 76c-15-6-28-2-36 9 11 9 25 10 34 1 7-7 8-15 6-23-2 5-3 9-4 13z" />

      {/* Hojas del lado derecho, más chicas: la rama crece hacia la luz */}
      <path d="M86 74c4-15 15-24 29-25-2 14-11 25-23 28-4 1-6 0-6-3z" />
      <path d="M110 48c6-14 18-21 32-20-4 14-14 23-27 25-4 0-6-2-5-5z" />
      <path d="M138 24c8-11 20-16 33-13-6 12-17 19-30 19-3 0-4-3-3-6z" />

      {/* Nervadura de dos hojas, apenas sugerida */}
      <path d="M40 158c6-2 12-4 16-8" strokeWidth="1.4" opacity="0.7" />
      <path d="M56 120c6-2 11-4 15-8" strokeWidth="1.4" opacity="0.7" />
    </svg>
  );
}

/* ---------------------------------------------------------------- iconos --- */

const comun = {
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: "false" as const,
};

/** Documentos: hojas de papel apiladas. */
export function IconoDocumentos({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M11.5 2.5H6a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 6 16.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5z" />
      <path d="M11.5 2.5v4h4" />
      <path d="M7.5 10.5h5M7.5 13h3.5" />
    </svg>
  );
}

/** Respuestas: un globo de diálogo con una marca. */
export function IconoRespuestas({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M17 9.5c0 3.3-3.1 6-7 6-.9 0-1.7-.1-2.5-.4L3.5 17l.9-3.1A5.6 5.6 0 0 1 3 9.5c0-3.3 3.1-6 7-6s7 2.7 7 6z" />
      <path d="M7.5 9.5l1.8 1.8 3.2-3.4" />
    </svg>
  );
}

/** Textos del bot: comillas. */
export function IconoTextos({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M8 5.5C6 6.4 4.7 8.2 4.7 10.3c0 1.7 1 2.9 2.4 2.9 1.3 0 2.2-.9 2.2-2.1 0-1.2-.8-2-1.9-2-.3 0-.5 0-.7.1.2-1.1 1-2.1 2.2-2.7z" />
      <path d="M15.6 5.5c-2 .9-3.3 2.7-3.3 4.8 0 1.7 1 2.9 2.4 2.9 1.3 0 2.2-.9 2.2-2.1 0-1.2-.8-2-1.9-2-.3 0-.5 0-.7.1.2-1.1 1-2.1 2.2-2.7z" />
    </svg>
  );
}

/** Reglas: una balanza. */
export function IconoReglas({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M10 3v14M6 17h8" />
      <path d="M4 6.5h12" />
      <path d="M4 6.5 2 11.5a2.6 2.6 0 0 0 4 0z" />
      <path d="M16 6.5l2 5a2.6 2.6 0 0 1-4 0z" />
    </svg>
  );
}

/** Pedidos y reclamos: un camión. */
export function IconoCasos({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M2.5 6.5h8v7h-8z" />
      <path d="M10.5 9h3.2l2.3 2.6v1.9h-5.5z" />
      <circle cx="6" cy="15" r="1.6" />
      <circle cx="13.5" cy="15" r="1.6" />
    </svg>
  );
}

/** No supo responder: un signo de pregunta en un círculo. */
export function IconoSinRespuesta({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8.1 7.8a2 2 0 0 1 3.9.6c0 1.3-1.9 1.6-1.9 3" />
      <path d="M10 14.2v.4" strokeWidth="2" />
    </svg>
  );
}

/**
 * Conversaciones: dos globos de diálogo.
 *
 * Se solapan a propósito, y el de atrás está incompleto: es lo que lo distingue
 * de un globo solo —que leería como «mensaje»— y lo hace leer como «ida y
 * vuelta». Comparte la gramática de trazo del resto: mismo viewBox, mismo
 * grosor, mismas terminaciones redondeadas.
 */
export function IconoConversaciones({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M3 8.2a3 3 0 0 1 3-3h5.5a3 3 0 0 1 3 3v2.1a3 3 0 0 1-3 3H7.8L5 15.6v-2.4a3 3 0 0 1-2-2.9z" />
      <path d="M14.9 7.4h.6a2.5 2.5 0 0 1 2.5 2.5v1.8a2.5 2.5 0 0 1-1.7 2.4v1.9l-2-1.7" />
    </svg>
  );
}

/** Métricas: barras. */
export function IconoMetricas({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M3 17h14" />
      <path d="M6 17V11M10 17V5.5M14 17V8.5" />
    </svg>
  );
}

/** Personal: dos siluetas. */
export function IconoPersonal({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <circle cx="8" cy="7" r="2.7" />
      <path d="M2.8 16.5c0-2.6 2.3-4.4 5.2-4.4s5.2 1.8 5.2 4.4" />
      <path d="M13.5 5.2a2.6 2.6 0 0 1 0 5" />
      <path d="M15 12.5c1.4.6 2.3 1.9 2.3 3.6" />
    </svg>
  );
}

/**
 * Tablero: un panel dividido en zonas.
 *
 * A propósito NO son barras: ese dibujo ya lo usa Métricas, y dos íconos de
 * barras en el mismo menú obligan a leer el texto para distinguirlos, que es
 * justo lo que un ícono tiene que evitar. Este muestra la FORMA de la pantalla
 * —un panel partido en bloques— y no lo que hay adentro.
 */
export function IconoTablero({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <rect x="3" y="3.5" width="14" height="13" rx="2.2" />
      <path d="M8.6 3.5v13" />
      <path d="M8.6 10h8.4" />
    </svg>
  );
}

/** Mensajes: un globo con líneas de texto. */
export function IconoMensajes({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M3 6a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 17 6v5.5a2.5 2.5 0 0 1-2.5 2.5H8l-3.5 3v-3A2.5 2.5 0 0 1 3 11.5z" />
      <path d="M6.5 7.5h7M6.5 10.3h4.5" />
    </svg>
  );
}

/** El voto del vecino: un pulgar. */
export function IconoPulgar({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M6 8.6 9.3 3a1.9 1.9 0 0 1 2.6 2.5L10.7 8h4.1a1.7 1.7 0 0 1 1.7 2l-1 5a1.7 1.7 0 0 1-1.7 1.4H6z" />
      <path d="M6 8.6H3.6v7.8H6z" />
    </svg>
  );
}

/** Plata: un billete. */
export function IconoPlata({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <rect x="2.5" y="5" width="15" height="10" rx="1.8" />
      <circle cx="10" cy="10" r="2.2" />
      <path d="M5.2 10h.01M14.8 10h.01" strokeWidth="2" />
    </svg>
  );
}

/**
 * Clima: un sol detrás de una nube.
 *
 * No es un pulgar, aunque la pantalla muestre pulgares: el ítem del menú tiene
 * que distinguirse de un ícono de voto suelto, y «clima» es la palabra que usa
 * el área para hablar de si el servicio está sirviendo o no.
 */
export function IconoClima({ className }: { className?: string }) {
  return (
    <svg {...comun} className={className}>
      <path d="M7.4 6.6a3 3 0 1 1 4.3 3.2" />
      <path d="M7.6 2.9v1.2M3.6 6.6h1.2M4.6 3.5l.9.9M10.6 3.5l-.9.9" strokeWidth="1.4" />
      <path d="M6.4 16.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.5 1.1 2.5 2.5 0 0 1-.4 4.9z" />
    </svg>
  );
}
