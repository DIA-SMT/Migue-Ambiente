import Link from "next/link";
import type { PersonaDelPanel } from "@/lib/supabase-servidor";
import { Salir } from "./Salir";
import { Tema } from "./Tema";
import {
  Hojas,
  IconoCasos,
  IconoClima,
  IconoConversaciones,
  IconoDocumentos,
  IconoMetricas,
  IconoPersonal,
  IconoReglas,
  IconoRespuestas,
  IconoTablero,
} from "./Botanica";

/**
 * El armazón del panel: barra lateral fija más el área de contenido.
 *
 * Las secciones se agrupan por para qué sirven, no por qué tabla tocan. «Lo que
 * Migue sabe» junta documentos, respuestas y textos porque son las tres formas
 * de cambiar lo que el bot contesta; «El día a día» junta lo que se mira todas
 * las mañanas. Un menú plano de siete ítems obliga a leerlos todos cada vez.
 *
 * Las que todavía no existen se listan igual, atenuadas y sin enlace: el área ve
 * el alcance completo de lo que el panel va a administrar, y no parece que
 * falten cosas por olvido.
 */
const GRUPOS = [
  {
    rotulo: "Lo que Migue sabe",
    items: [
      { href: "/documentos", texto: "Documentos", Icono: IconoDocumentos, listo: true },
      // Se llamaba «Respuestas» y el nombre era ambiguo entre dos cosas casi
      // opuestas: las respuestas que Migue DIO y las que nosotros le ESCRIBIMOS.
      // Alguien entró buscando las primeras y encontró las segundas. Ahora las
      // conversaciones tienen su propia sección y esta se llama por lo que es.
      //
      // Junta TODO lo que Migue dice y el área puede cambiar, en cuatro
      // pestañas: lo que no supo contestar, las preguntas frecuentes, las
      // respuestas textuales y las frases fijas con las que habla.
      //
      // Estaban en dos ítems del menú —«Respuestas» y «Textos del bot»— y eso
      // obligaba a saber de antemano en cuál de los dos vivía la frase que se
      // quería corregir. Y la primera pestaña es la lista de trabajo: una
      // pregunta sin responder es el insumo para escribir una respuesta, así que
      // leer la falla y arreglarla pasaron a ser la misma pantalla.
      { href: "/conocimiento", texto: "Conocimiento", Icono: IconoRespuestas, listo: true },
      { href: "/reglas", texto: "Reglas", Icono: IconoReglas, listo: true },
    ],
  },
  {
    rotulo: "El día a día",
    items: [
      // Primera del grupo: es lo que se mira para saber si Migue está sirviendo.
      // El voto del vecino se ve acá y en ningún otro lado.
      // Primera del grupo: es el único dato del panel donde habla el vecino.
      // Todo lo demás son deducciones nuestras mirando lo que hizo el bot.
      { href: "/clima", texto: "Clima", Icono: IconoClima, listo: true },
      { href: "/conversaciones", texto: "Conversaciones", Icono: IconoConversaciones, listo: true },
      { href: "/casos", texto: "Pedidos y reclamos", Icono: IconoCasos, listo: true },
      { href: "/metricas", texto: "Métricas", Icono: IconoMetricas, listo: true },
    ],
  },
  {
    rotulo: "Administración",
    items: [{ href: "/personal", texto: "Personal", Icono: IconoPersonal, listo: true }],
  },
] as const;

export function Armazon({
  persona,
  actual,
  children,
}: {
  persona: PersonaDelPanel;
  actual: string;
  children: React.ReactNode;
}) {
  return (
    <div className="armazon">
      <aside className="barra">
        {/* La marca es el camino de vuelta a la portada, y es el único: la
            portada no está en el menú y no tiene por qué estar —no es una
            sección, es dónde uno cae al entrar—. Sin este enlace, desde
            cualquier pantalla sólo se volvía con el botón de atrás. */}
        <div className="barra-marca">
          <Link href="/">
            <div className="nombre">
              Migue <em>Ambiente</em>
            </div>
            <div className="area">Ambiente y Desarrollo Sustentable</div>
          </Link>
        </div>

        <nav className="barra-nav" aria-label="Secciones del panel">
          {/* El tablero va suelto y sin rótulo de grupo: no es una sección más
              —no administra nada—, es la pantalla a la que uno vuelve y la
              primera que ve al entrar.

              Se compara por IGUALDAD y no con `startsWith` como el resto. Es la
              única ruta donde importa: "/" es prefijo de todas las demás, así
              que con `startsWith` el tablero quedaría marcado como la sección
              activa estando parado en cualquier pantalla del panel. */}
          <Link href="/" aria-current={actual === "/" ? "page" : undefined}>
            <IconoTablero className="icono" />
            Tablero
          </Link>

          {GRUPOS.map((grupo) => (
            <div key={grupo.rotulo}>
              <div className="rotulo-grupo">{grupo.rotulo}</div>
              {grupo.items.map(({ href, texto, Icono, listo }) =>
                listo ? (
                  <Link
                    key={href}
                    href={href}
                    aria-current={actual.startsWith(href) ? "page" : undefined}
                  >
                    <Icono className="icono" />
                    {texto}
                  </Link>
                ) : (
                  <div key={href} className="pendiente" title="Todavía no construida">
                    <Icono className="icono" />
                    {texto}
                  </div>
                ),
              )}
            </div>
          ))}
        </nav>

        <div className="barra-pie">
          <div className="quien">
            <strong>{persona.nombre ?? persona.correo}</strong>
            <span>{persona.rol}</span>
          </div>
          <Tema />
          <Salir />
        </div>

        {/* La firma de quién construyó el panel. Va última, debajo de la ficha de
            quién lo está usando: es un crédito de autoría y no una sección más.
            `img` y no `next/image` a propósito — es un PNG estático de 20 kB, y
            el optimizador de Next exige tener `sharp` instalado en la VPS a
            cambio de nada. Los atributos de tamaño van igual, para que el
            navegador reserve el lugar y la barra no salte al cargar. */}
        <div className="barra-credito">
          <span className="rotulo">Desarrollado por</span>
          <img
            src="/marca/dia-sobre-oscuro.png"
            alt="Dirección de IA · Municipalidad de San Miguel de Tucumán"
            width={222}
            height={88}
          />
        </div>

        <Hojas className="barra-hojas" />
      </aside>

      <div className="contenido">{children}</div>
    </div>
  );
}
