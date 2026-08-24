import { Hojas } from "@/componentes/Botanica";

/**
 * El ingreso no lleva barra lateral: no hay a dónde navegar todavía, y mostrar
 * los nombres de las secciones a quien no entró es filtrar la estructura interna
 * sin necesidad.
 *
 * Fondo verde profundo con las hojas de marca de agua, para que la primera
 * pantalla ya diga de qué área es esto antes de leer una palabra.
 */
export default function LayoutIngreso({ children }: { children: React.ReactNode }) {
  return (
    <div className="pantalla-ingreso">
      <Hojas className="ingreso-hojas una" />
      <Hojas className="ingreso-hojas dos" />
      {children}
    </div>
  );
}
