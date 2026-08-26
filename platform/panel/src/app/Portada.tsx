import Link from "next/link";
import type { PersonaDelPanel } from "@/lib/supabase-servidor";

/**
 * Una cosa que está esperando a que alguien la mire.
 *
 * No es una métrica: la pantalla de Métricas ya cuenta todo lo que se puede
 * contar. Acá sólo entra lo que tiene una acción del otro lado, y por eso cada
 * una lleva `adonde` — un pendiente que no lleva a ninguna pantalla es una
 * preocupación, no una tarea.
 */
export interface Pendiente {
  readonly cuanto: number;
  readonly que: string;
  readonly porQue: string;
  readonly adonde: string;
  readonly urgente: boolean;
}

/**
 * El saludo, según la hora de Tucumán y no la del servidor.
 *
 * La VPS corre en UTC. Sin fijar la zona, a las nueve de la noche de Tucumán el
 * panel saludaría con un «buen día», porque en UTC ya pasó la medianoche.
 *
 * `hourCycle: "h23"` y no `hour12: false`: con `hour12` hay versiones de ICU que
 * devuelven «24» para la medianoche, y `24 < 13` es falso — el saludo de la
 * medianoche saldría «buenas noches» por accidente y el de la una de la mañana
 * también, pero por el motivo equivocado.
 *
 * Se lee con `formatToParts` en vez de parsear el texto formateado, que según el
 * locale puede venir como «09», «9» o «9 h».
 */
function saludo(ahora: Date): string {
  const partes = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Tucuman",
    hourCycle: "h23",
    hour: "numeric",
  }).formatToParts(ahora);

  const hora = Number(partes.find((p) => p.type === "hour")?.value ?? "12");

  if (hora < 13) return "Buen día";
  if (hora < 20) return "Buenas tardes";
  return "Buenas noches";
}

/**
 * La portada del panel.
 *
 * Durante mucho tiempo esta ruta fue un `redirect` a Documentos, con un
 * comentario que decía que inventar un tablero con una sola sección construida
 * sería una pantalla vacía con aire de estar terminada. Era cierto entonces.
 * Ahora hay siete secciones y dos listas de trabajo con nombre y apellido, así
 * que la portada tiene algo real que decir cuando alguien la abre a la mañana.
 *
 * Lo que NO hace es repetir el menú en forma de tarjetas: la barra lateral está
 * a diez píxeles de acá. Muestra lo que espera a una persona, y nada más. Si no
 * espera nada, lo dice y se termina — una portada que rellena con números
 * cuando no hay nada que hacer enseña a no leerla.
 */
export function Portada({
  persona,
  pendientes,
  problema,
  ahora,
}: {
  persona: PersonaDelPanel;
  pendientes: readonly Pendiente[];
  problema: string | null;
  ahora: Date;
}) {
  // Sólo el nombre de pila. «Buenas tardes, Matías» es un saludo; «Buenas
  // tardes, Matías Ezequiel Luján» es un encabezado de expediente.
  const nombre = persona.nombre?.trim().split(" ")[0];

  return (
    <main>
      <section className="portada-hola">
        <div className="dicho">
          <h1>
            {saludo(ahora)}
            {nombre ? `, ${nombre}` : ""}
          </h1>
          <p>
            Este es el panel de Migue, el asistente que contesta las consultas ambientales de los
            vecinos. Desde acá se cambia lo que sabe, lo que responde y qué pasa con lo que la gente
            pide.
          </p>
        </div>

        {/* `img` y no `next/image`: el optimizador de Next exige `sharp`
            instalado en la VPS, y acá no compraría nada — el archivo ya está en
            el tamaño en que se muestra. Los atributos de tamaño van igual, para
            que el navegador reserve el lugar y la tarjeta no salte al cargar.

            WebP y no PNG: son 73 kB contra 302 kB por el mismo dibujo con la
            misma transparencia. Nginx proxea todo a Next, así que el tipo MIME
            lo pone Next y no hay que tocar la configuración del servidor.

            `alt` vacío y `aria-hidden`: es un dibujo, no información. Un lector
            de pantalla que lo anuncie sólo mete ruido antes del contenido. */}
        <img
          src="/marca/migue.webp"
          alt=""
          aria-hidden="true"
          width={362}
          height={600}
        />
      </section>

      {problema && <div className="aviso mal">No pude leer los pendientes: {problema}</div>}

      <h2>Lo que está esperando</h2>

      {pendientes.length === 0 ? (
        <div className="portada-al-dia">
          No hay nada esperando: ninguna pregunta sin responder y ningún caso abierto.
        </div>
      ) : (
        <div className="portada-atencion">
          {pendientes.map((p) => (
            <Link key={p.adonde + p.que} href={p.adonde} className={p.urgente ? "urgente" : ""}>
              <span className="n">{p.cuanto}</span>
              <span className="r">{p.que}</span>
              <span className="p">{p.porQue}</span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
