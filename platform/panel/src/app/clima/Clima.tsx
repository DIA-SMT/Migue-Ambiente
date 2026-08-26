"use client";

import { useState } from "react";
import Link from "next/link";
import { fechaLegible } from "@/lib/tipos";

/** Una fila de `valoraciones` con el mensaje que valoró y de quién fue. */
export interface VotoConContexto {
  id: string;
  voto: "util" | "no_util";
  /** `respuesta` = «te sirvió lo que te contesté». `tramite` = «te resultó fácil». */
  sobre: "respuesta" | "tramite";
  comentario: string | null;
  creado_en: string;
  conversacion_id: string;
  /** El saliente valorado. PostgREST lo devuelve como objeto por la clave foránea. */
  mensajes: { texto: string | null } | null;
  conversaciones: { nombre_usuario: string | null; canal: string } | null;
}

const CANALES: Record<string, string> = { telegram: "Telegram", whatsapp: "WhatsApp" };

/**
 * La lista de votos.
 *
 * Arranca en «Le faltó algo» y no en «Todos», y no es un detalle: los pulgares
 * arriba son agradables de mirar y no piden nada. Lo que hay que hacer cuando
 * se abre esta pantalla está del otro lado.
 *
 * Cada voto se muestra con LO QUE MIGUE HABÍA CONTESTADO. Un pulgar abajo suelto
 * dice que algo falló; un pulgar abajo con la respuesta al lado dice qué hay que
 * reescribir. Es la diferencia entre una métrica y una tarea.
 */
export function Clima({ votos }: { votos: readonly VotoConContexto[] }) {
  const negativos = votos.filter((v) => v.voto === "no_util");
  const positivos = votos.filter((v) => v.voto === "util");
  const conComentario = negativos.filter((v) => (v.comentario ?? "").trim() !== "");

  const [pestana, setPestana] = useState<"malos" | "buenos">("malos");
  const lista = pestana === "malos" ? negativos : positivos;

  return (
    <>
      <div className="resumen">
        <div>
          <span className="n">{votos.length}</span>
          <span className="r">Votos en total</span>
        </div>
        <div>
          <span className="n">{positivos.length}</span>
          <span className="r">Les sirvió</span>
        </div>
        <div>
          <span className="n">{negativos.length}</span>
          <span className="r">No les sirvió</span>
        </div>
        <div>
          <span className="n">{conComentario.length}</span>
          <span className="r">Contaron qué faltó</span>
        </div>
      </div>

      {/* Sin porcentaje a propósito mientras haya pocos votos: «100% útil» con un
          voto tiene la misma forma que con mil y no significa lo mismo. La
          pantalla de Conversaciones ya usa este mismo umbral. */}
      {votos.length > 0 && votos.length < 10 && (
        <div className="aviso-muestra">
          <div>
            <strong>Son muy pocos votos para sacar una proporción.</strong>
            Con {votos.length} {votos.length === 1 ? "voto" : "votos"}, cada uno nuevo mueve
            cualquier porcentaje varios puntos. Los votos de a uno sí sirven: cada pulgar abajo es
            una respuesta concreta para corregir.
          </div>
        </div>
      )}

      <div className="pestanas">
        <button
          className={pestana === "malos" ? "activa" : ""}
          onClick={() => setPestana("malos")}
          type="button"
        >
          Le faltó algo <span className="cuenta">{negativos.length}</span>
        </button>
        <button
          className={pestana === "buenos" ? "activa" : ""}
          onClick={() => setPestana("buenos")}
          type="button"
        >
          Le sirvió <span className="cuenta">{positivos.length}</span>
        </button>
      </div>

      {lista.length === 0 ? (
        <div className="tarjeta vacio">
          {pestana === "malos"
            ? "Ningún vecino votó que le faltó algo."
            : "Todavía nadie votó que le sirvió."}
        </div>
      ) : (
        <div className="lista-preguntas">
          {lista.map((v) => (
            <Ficha key={v.id} voto={v} />
          ))}
        </div>
      )}
    </>
  );
}

function Ficha({ voto }: { voto: VotoConContexto }) {
  const malo = voto.voto === "no_util";
  const comentario = (voto.comentario ?? "").trim();
  const dijo = voto.mensajes?.texto ?? null;
  const quien = voto.conversaciones?.nombre_usuario ?? "Un vecino";
  const canal = voto.conversaciones?.canal;

  return (
    <article className="tarjeta pregunta voto-ficha">
      <header>
        <div className="marcas">
          <span className={`chip ${malo ? "alerta" : "ok"}`}>
            {malo ? "no le sirvió" : "le sirvió"}
          </span>
          {/* Qué se arregla NO es lo mismo según sobre qué votó, y por eso la
              etiqueta lo dice: una respuesta mala se corrige escribiendo, un
              trámite difícil se corrige sacando un paso, y lo hace otra persona. */}
          <span className="chip pend">
            {voto.sobre === "respuesta" ? "sobre una respuesta" : "sobre un trámite"}
          </span>
        </div>
        <span className="sub-fila">{fechaLegible(voto.creado_en)}</span>
      </header>

      {dijo === null ? (
        <p className="ayuda">
          No queda el texto de lo que Migue había contestado. Sin eso, este voto sólo dice que algo
          falló y no qué.
        </p>
      ) : (
        <>
          <span className="rotulo-cita">Lo que Migue había contestado</span>
          <blockquote>{dijo}</blockquote>
        </>
      )}

      {comentario === "" ? (
        <p className="ayuda">
          {malo
            ? "El vecino no escribió qué le faltó. Migue se lo pregunta, pero contestar es opcional."
            : "Sin comentario."}
        </p>
      ) : (
        <div className="dijo-el-vecino">
          <span className="rotulo-cita">Y el vecino escribió</span>
          <blockquote>{comentario}</blockquote>
        </div>
      )}

      <div className="acciones">
        <span className="sub-fila" style={{ alignSelf: "center" }}>
          {quien}
          {canal ? ` · ${CANALES[canal] ?? canal}` : ""}
        </span>
        <Link className="boton chico" href={`/conversaciones?abrir=${voto.conversacion_id}`}>
          Ver la charla entera
        </Link>
      </div>
    </article>
  );
}
