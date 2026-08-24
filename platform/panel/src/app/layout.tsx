import type { Metadata, Viewport } from "next";

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
      <body>{children}</body>
    </html>
  );
}
