import type { Metadata, Viewport } from "next";
import "./global.css";

export const metadata: Metadata = {
  title: "Panel · Migue Ambiente",
  description: "Administración del bot de consultas ambientales de San Miguel de Tucumán",
  // El panel no es contenido público: no tiene por qué aparecer en un buscador.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RaizLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <head>
        {/* Las dos familias de la identidad del municipio. `display=swap` para
            que el panel se lea con la fuente del sistema mientras cargan. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=Asap:wght@400;500;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
