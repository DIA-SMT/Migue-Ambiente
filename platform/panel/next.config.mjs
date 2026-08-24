/**
 * Configuración de Next.js para el panel.
 *
 * Corre en la VPS, detrás de nginx, escuchando sólo en loopback.
 */

/** @type {import('next').NextConfig} */
export default {
  // El panel importa `@migue/dominio/compartido`, que es TypeScript sin
  // compilar dentro del workspace. Sin esto Next no lo transpila y falla al
  // construir.
  transpilePackages: ["@migue/dominio"],

  // No se filtra la versión de Next en las respuestas: es información gratis
  // para quien busque una vulnerabilidad conocida.
  poweredByHeader: false,

  // nginx ya comprime. Hacerlo dos veces sólo gasta CPU de una VPS de 2 núcleos.
  compress: false,

};
