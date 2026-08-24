/**
 * El ingreso no lleva la cabecera con navegación: no hay a dónde navegar
 * todavía, y mostrar los nombres de las secciones a quien no entró es filtrar
 * la estructura interna sin necesidad.
 */
export default function LayoutIngreso({ children }: { children: React.ReactNode }) {
  return <div className="pantalla-centrada">{children}</div>;
}
