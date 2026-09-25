"use client";

import { useEffect, useState } from "react";
import {
  CATEGORIA_FOTO_LEGIBLE,
  datosFaltantes,
  fechaLegible,
  situacionSla,
  veredictoDeFoto,
  type SolicitudPrograma,
  type Ticket,
} from "@/lib/tipos";
import { guardarNota, urlDeFoto, type Resultado } from "./acciones";

function esTicket(c: Ticket | SolicitudPrograma): c is Ticket {
  return "ticket_type" in c;
}

/** Un campo de la ficha. Se omite si no hay dato: una fila vacía es ruido. */
function Dato({ rotulo, valor }: { rotulo: string; valor: string | number | null | undefined }) {
  if (valor === null || valor === undefined || valor === "") return null;
  return (
    <>
      <dt>{rotulo}</dt>
      <dd>{valor}</dd>
    </>
  );
}

/**
 * La ficha completa de un caso.
 *
 * Todo lo que se ve acá lo cargó el vecino a través del bot, así que es de sólo
 * lectura salvo dos cosas: el estado —que se cambia desde la lista— y una nota
 * interna. Editar la dirección o la cantidad sería reescribir lo que dijo una
 * persona, y el ticket es el respaldo documental de un trámite.
 */
export function FichaCaso({
  caso,
  alCerrar,
  alCambiar,
}: {
  caso: Ticket | SolicitudPrograma;
  alCerrar: () => void;
  alCambiar: (r: Resultado) => void;
}) {
  const ticket = esTicket(caso) ? caso : null;
  const solicitud = esTicket(caso) ? null : caso;
  const [nota, setNota] = useState(ticket?.notes ?? "");
  const [guardando, setGuardando] = useState(false);
  const [foto, setFoto] = useState<string | null>(null);
  const [fotoPedida, setFotoPedida] = useState(false);

  // La URL se pide firmada y sólo cuando hay algo que mostrar. El bucket es
  // privado: son fotos de la propiedad de un vecino.
  useEffect(() => {
    if (fotoPedida || !caso.photo_url) return;
    setFotoPedida(true);
    void urlDeFoto(caso.photo_url).then(setFoto);
  }, [caso.photo_url, fotoPedida]);

  const s = ticket ? situacionSla(ticket) : null;
  const faltan = ticket ? datosFaltantes(ticket) : [];

  return (
    <>
      <div className="velo" onClick={alCerrar} aria-hidden="true" />
      <aside className="cajon" role="dialog" aria-modal="true" aria-label="Ficha del caso">
        <div className="cajon-cabecera">
          <div>
            <h2>
              {ticket ? ticket.ticket_type : `Programa ${solicitud!.program_type.toUpperCase()}`}
            </h2>
            <div className="sub-fila">{fechaLegible(caso.created_at, true)}</div>
          </div>
          <button className="chico" onClick={alCerrar}>
            Cerrar
          </button>
        </div>

        <div className="cajon-cuerpo">
          {s && (
            <div style={{ marginBottom: 14 }}>
              <span className={`chip ${s.tono}`}>{s.etiqueta}</span>{" "}
              <span className="chip ok">{caso.status}</span>
            </div>
          )}

          {faltan.length > 0 && (
            <div className="aviso atencion">
              Este caso quedó incompleto: falta {faltan.join(", ")}. Los pedidos que dejó el bot
              anterior suelen no tener tipo ni cantidad.
            </div>
          )}

          <dl className="ficha">
            {ticket ? (
              <>
                <Dato rotulo="Dirección" valor={ticket.address} />
                <Dato rotulo="Tipo de residuo" valor={ticket.waste_type} />
                <Dato rotulo="Cantidad" valor={ticket.quantity} />
                <Dato
                  rotulo="Cantidad medida"
                  valor={
                    ticket.quantity_value !== null
                      ? `${ticket.quantity_value} ${ticket.quantity_unit ?? ""}`.trim()
                      : null
                  }
                />
                <Dato rotulo="Excede el límite" valor={ticket.exceeds_limit ? "sí" : null} />
                <Dato rotulo="Retiro parcial" valor={ticket.partial_pickup ? "sí" : null} />
                <Dato rotulo="Días sin servicio" valor={ticket.days_without_service} />
                <Dato rotulo="Derivado a" valor={ticket.derived_to} />
                <Dato
                  rotulo="Vence"
                  valor={ticket.sla_deadline ? fechaLegible(ticket.sla_deadline, true) : null}
                />
                <Dato
                  rotulo="Resuelto"
                  valor={ticket.resolved_at ? fechaLegible(ticket.resolved_at, true) : null}
                />
              </>
            ) : (
              <>
                <Dato rotulo="Institución" valor={solicitud!.institution_name} />
                <Dato rotulo="Responsable" valor={solicitud!.responsible_person} />
                <Dato rotulo="Teléfono" valor={solicitud!.contact_phone} />
                <Dato rotulo="Personas" valor={solicitud!.student_count} />
                <Dato rotulo="Dirección" valor={solicitud!.address} />
                <Dato rotulo="Horario preferido" valor={solicitud!.preferred_time} />
                <Dato rotulo="Información extra" valor={solicitud!.additional_info} />
                <Dato
                  rotulo="Resuelto"
                  valor={solicitud!.resolved_at ? fechaLegible(solicitud!.resolved_at, true) : null}
                />
              </>
            )}
            <Dato rotulo="Vecino" valor={caso.user_name} />
            <Dato rotulo="Canal" valor={"channel" in caso ? caso.channel : null} />
          </dl>

          <h3 style={{ marginTop: 22 }}>Foto</h3>
          {/* Lo que la visión dijo de la foto. Es la opinión del MODELO, no un
              dato del vecino: se muestra junto a la imagen para que quien mira
              la ficha la contraste con sus propios ojos. */}
          {ticket && veredictoDeFoto(ticket) && (
            <p style={{ marginTop: 8 }}>
              <span className={`chip ${veredictoDeFoto(ticket)!.tono}`}>
                {veredictoDeFoto(ticket)!.etiqueta}
              </span>
              {ticket.photo_category && (
                <span className="sub-fila" style={{ marginLeft: 8 }}>
                  {CATEGORIA_FOTO_LEGIBLE[ticket.photo_category] ?? ticket.photo_category}
                </span>
              )}
              {ticket.photo_detail && <span className="ayuda" style={{ display: "block", marginTop: 4 }}>«{ticket.photo_detail}»</span>}
            </p>
          )}
          {foto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={foto}
              alt="Foto que mandó el vecino"
              style={{ maxWidth: "100%", borderRadius: 10, marginTop: 8 }}
            />
          ) : caso.photo_url ? (
            <p className="ayuda">Cargando la foto…</p>
          ) : caso.photo_ref ? (
            <p className="ayuda">
              El vecino mandó una foto y el worker todavía no la guardó. Si pasaron más de unos
              minutos, es probable que el canal ya no la tenga.
            </p>
          ) : (
            <p className="ayuda">Sin foto.</p>
          )}

          {ticket && (
            <>
              <h3 style={{ marginTop: 22 }}>Nota interna</h3>
              <p className="ayuda" style={{ marginTop: 0 }}>
                Lo único que el panel escribe acá. El resto lo cargó el vecino y cambiarlo sería
                reescribir lo que dijo.
              </p>
              <textarea
                value={nota}
                onChange={(e) => setNota(e.target.value)}
                placeholder="Qué se hizo, con quién se habló, por qué se derivó."
              />
              <button
                className="primario"
                style={{ marginTop: 8 }}
                disabled={guardando || nota === (ticket.notes ?? "")}
                onClick={async () => {
                  setGuardando(true);
                  alCambiar(await guardarNota(ticket.id, nota));
                  setGuardando(false);
                }}
              >
                {guardando ? "Guardando…" : "Guardar nota"}
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
