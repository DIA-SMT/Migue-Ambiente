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
    // `suppressHydrationWarning` en el <html> y en ningún otro lado: el script
    // de arriba le escribe `data-tema` antes de que React hidrate, así que el
    // atributo que ve el cliente no es el que mandó el servidor. Es la única
    // diferencia esperada, y silenciarla acá no tapa ninguna otra.
    <html lang="es-AR" suppressHydrationWarning>
      <head>
        {/* El tema, ANTES de que se pinte nada.
            
            Va como script en linea en el `<head>` y no en un efecto de React por
            una razon sola: un efecto corre despues del primer pintado, asi que
            quien eligio oscuro veria un destello blanco en cada carga. Esto lee
            la eleccion guardada y marca el `<html>` antes de que el navegador
            dibuje el primer pixel.

            Si no hay nada guardado no toca nada, y ahi manda
            `prefers-color-scheme` desde el CSS: el panel arranca con el tema de
            la maquina de cada uno.

            El try/catch no es decoracion: en el modo privado de algunos
            navegadores `localStorage` tira al leerlo, y sin catch ese error
            frena el script y deja la pagina a medio configurar. */}
        {/* Para que los controles que dibuja el navegador —barras de scroll,
            selectores de fecha, autocompletado— acompañen al tema en vez de
            quedar blancos en medio de una pantalla oscura. */}
        <meta name="color-scheme" content="light dark" />

        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('migue-tema');" +
              "if(t==='claro'||t==='oscuro'){document.documentElement.dataset.tema=t}}catch(e){}",
          }}
        />

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
