"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type {
  FilaConfiguracion,
  FilaExclusion,
  FilaLimite,
  FilaPuntoVerde,
  FilaZona,
} from "@/lib/tipos";
import type { Resultado } from "./acciones";
import { Configuracion } from "./Configuracion";
import { Limites } from "./Limites";
import { Exclusiones } from "./Exclusiones";
import { PuntosYZonas } from "./PuntosYZonas";

/**
 * Las reglas, en cuatro pestañas.
 *
 * El orden es por consecuencia decreciente: primero lo que cambia el plazo que
 * el municipio promete y cuándo el bot se anima a hablar, después los límites del
 * servicio, después qué se deriva, y al final los datos que hoy casi no se usan.
 *
 * Arriba de todo va un aviso que no es decorativo. Los límites, las direcciones
 * de los Puntos Verdes y los días de zona están escritos TAMBIÉN adentro de los
 * documentos indexados, y una consulta libre se contesta con el texto del PDF, no
 * con estas tablas. Sin ese aviso, alguien baja el límite de poda acá, le
 * pregunta a Migue, recibe el número viejo con voz de institución, y no tiene
 * ninguna forma de entender por qué.
 */
type Pestana = "config" | "limites" | "exclusiones" | "puntos";

export function Reglas({
  configuracion,
  limites,
  exclusiones,
  puntos,
  zonas,
  documentosDuplicados,
}: {
  configuracion: FilaConfiguracion[];
  limites: FilaLimite[];
  exclusiones: FilaExclusion[];
  puntos: FilaPuntoVerde[];
  zonas: FilaZona[];
  documentosDuplicados: string[];
}) {
  const router = useRouter();
  const [pestana, setPestana] = useState<Pestana>("config");
  const [aviso, setAviso] = useState<Resultado | null>(null);

  function alGuardar(r: Resultado) {
    setAviso(r);
    if (r.ok) router.refresh();
  }

  const SOLAPAS: { id: Pestana; texto: string; cuenta: number }[] = [
    { id: "config", texto: "Cómo decide Migue", cuenta: configuracion.length },
    { id: "limites", texto: "Cuánto se puede sacar", cuenta: limites.length },
    { id: "exclusiones", texto: "Fuera de alcance", cuenta: exclusiones.length },
    { id: "puntos", texto: "Puntos Verdes y zonas", cuenta: puntos.length + zonas.length },
  ];

  return (
    <>
      {aviso && (
        <div className={`aviso ${aviso.ok ? "ok" : "mal"}`} role="status">
          {aviso.mensaje}
        </div>
      )}

      {documentosDuplicados.length > 0 && (
        <div className="aviso atencion">
          <strong>Estos datos están repetidos adentro de los documentos indexados.</strong>
          <div style={{ marginTop: 6 }}>
            Los límites, las direcciones de los Puntos Verdes y los días de zona también están
            escritos en{" "}
            {documentosDuplicados.map((t, i) => (
              <span key={t}>
                {i > 0 && (i === documentosDuplicados.length - 1 ? " y " : ", ")}
                <em>{t}</em>
              </span>
            ))}
            . Cuando un vecino <strong>pregunta</strong> por ellos —en lugar de hacer un trámite—
            Migue redacta con el texto del documento, no con estas tablas. Así que si cambiás un
            número acá, la consulta libre va a seguir contestando el valor viejo.
          </div>
          <div style={{ marginTop: 6 }}>
            Para que el cambio valga en los dos lados hay que corregir también el documento en{" "}
            <Link href="/documentos">Documentos</Link>, o escribir una{" "}
            <Link href="/conocimiento">pregunta frecuente</Link> con el valor correcto: lo que
            escribe el área pesa el doble que un fragmento de PDF cuando Migue busca.
          </div>
        </div>
      )}

      <div className="pestanas" role="tablist">
        {SOLAPAS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={pestana === s.id}
            className={pestana === s.id ? "activa" : ""}
            onClick={() => setPestana(s.id)}
          >
            {s.texto}
            <span className="cuenta">{s.cuenta}</span>
          </button>
        ))}
      </div>

      {pestana === "config" && (
        <Configuracion filas={configuracion} alGuardar={alGuardar} />
      )}
      {pestana === "limites" && <Limites filas={limites} alGuardar={alGuardar} />}
      {pestana === "exclusiones" && <Exclusiones filas={exclusiones} alGuardar={alGuardar} />}
      {pestana === "puntos" && <PuntosYZonas puntos={puntos} zonas={zonas} limites={limites} />}
    </>
  );
}
