"use client";

import { useState } from "react";
import type { FilaLimite, FilaPuntoVerde, FilaZona } from "@/lib/tipos";
import {
  borrarPuntoVerde,
  borrarZona,
  guardarPuntoVerde,
  guardarZona,
  type Resultado,
} from "./acciones";
import { DIA_LEGIBLE, DIAS_SEMANA } from "@/lib/reglas";

/**
 * Puntos Verdes y zonas de recolección.
 *
 * ESTA PESTAÑA ERA DE SÓLO LECTURA, y el motivo estaba bien: las dos tablas
 * estaban desconectadas del bot. Un formulario que guarda un dato que no cambia
 * nada es peor que no tener formulario — alguien corrige una dirección, ve que
 * Migue sigue diciendo la vieja, y deja de creerle al panel entero.
 *
 * El motivo dejó de valer. La respuesta textual de Puntos Verdes ahora dice
 * `{puntos_verdes}` y una pregunta frecuente dice `{zonas}`: las dos se resuelven
 * contra estas tablas al momento de contestar. Y los documentos que tenían las
 * direcciones copiadas adentro se dieron de baja, así que no hay una segunda
 * fuente compitiendo por el ranking de la búsqueda.
 *
 * Cada fila muestra CÓMO SE VA A ESCUCHAR, con la misma forma que arma el bot:
 * «• dirección — horario». Es la diferencia entre editar una fila de tabla y
 * editar lo que le llega a un vecino, y es lo que evita el error clásico de
 * cargar bien los campos y que la frase salga rara.
 */
export function PuntosYZonas({
  puntos,
  zonas,
  limites,
  alGuardar,
}: {
  puntos: FilaPuntoVerde[];
  zonas: FilaZona[];
  limites: FilaLimite[];
  alGuardar: (r: Resultado) => void;
}) {
  const [pv, setPv] = useState<FilaPuntoVerde | null | undefined>(undefined);
  const [zona, setZona] = useState<FilaZona | null | undefined>(undefined);
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function ejecutar(accion: () => Promise<Resultado>) {
    setGuardando(true);
    const r = await accion();
    alGuardar(r);
    setGuardando(false);
    setConfirmando(null);
    if (r.ok) {
      setPv(undefined);
      setZona(undefined);
    }
  }

  return (
    <>
      {/* ------------------------------------------------ Puntos Verdes --- */}

      <div className="titulo-pagina" style={{ marginTop: 8 }}>
        <div>
          <h2>Puntos Verdes</h2>
          <p className="ayuda" style={{ maxWidth: "70ch" }}>
            Lo que Migue contesta cuando alguien pregunta dónde llevar sus reciclables. La respuesta
            no tiene las direcciones escritas adentro: las lee de acá cada vez, así que lo que
            cambies se dice dentro de un minuto.
          </p>
        </div>
        <button className="primario" onClick={() => setPv(null)}>
          Agregar Punto Verde
        </button>
      </div>

      {puntos.length === 0 ? (
        <div className="tarjeta vacio">
          No hay ninguno cargado. Migue va a decir que no tiene Puntos Verdes para ofrecer.
        </div>
      ) : (
        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th>Cómo se escucha</th>
                <th>Nombre</th>
                <th>Tipo</th>
                <th className="num">Orden</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {[...puntos]
                .sort((a, b) => a.orden - b.orden)
                .map((p) => (
                  <tr key={p.id} className={p.activo ? "" : "de-baja"}>
                    <td>
                      {/* La misma forma que arma `describirPuntosVerdes` en el
                          dominio. Si algún día cambia allá, esto queda viejo —
                          pero mostrar la fila cruda sería peor: nadie puede
                          revisar una frase que no ve. */}
                      <span className="titulo-fila">
                        • {p.direccion} — {p.horario ?? "24 hs"}
                      </span>
                      {p.observaciones && <div className="sub-fila">({p.observaciones})</div>}
                    </td>
                    <td>{p.nombre ?? "—"}</td>
                    <td>
                      <span className="chip pend">{p.tipo ?? "contenedor"}</span>
                    </td>
                    <td className="num">{p.orden}</td>
                    <td>
                      <div className="acciones">
                        <button className="chico" onClick={() => setPv(p)} disabled={guardando}>
                          Editar
                        </button>
                        {confirmando === p.id ? (
                          <>
                            <button
                              className="chico peligro"
                              disabled={guardando}
                              onClick={() => ejecutar(() => borrarPuntoVerde(p.id))}
                            >
                              Confirmar
                            </button>
                            <button className="chico" onClick={() => setConfirmando(null)}>
                              No
                            </button>
                          </>
                        ) : (
                          <button
                            className="chico peligro"
                            onClick={() => setConfirmando(p.id)}
                            disabled={guardando}
                          >
                            Borrar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* -------------------------------------------------------- zonas --- */}

      <div className="titulo-pagina" style={{ marginTop: 34 }}>
        <div>
          <h2>Zonas de recolección</h2>
          <p className="ayuda" style={{ maxWidth: "70ch" }}>
            Los días que Migue contesta cuando preguntan por qué día pasa el camión. Se leen de acá
            cada vez, igual que los Puntos Verdes.
          </p>
        </div>
        <button className="primario" onClick={() => setZona(null)}>
          Agregar zona
        </button>
      </div>

      {zonas.length === 0 ? (
        <div className="tarjeta vacio">
          No hay ninguna cargada. Migue va a decir que no tiene las zonas cargadas.
        </div>
      ) : (
        <div className="envoltorio-tabla tarjeta">
          <table>
            <thead>
              <tr>
                <th>Cómo se escucha</th>
                <th>Zona</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {zonas.map((z) => (
                <tr key={z.id} className={z.activo ? "" : "de-baja"}>
                  <td>
                    <span className="titulo-fila">
                      • {z.nombre}: {enumerar(z.dias)}
                      {z.hora_sacar ? `, sacar a las ${z.hora_sacar}` : ""}
                    </span>
                    {z.observaciones && <div className="sub-fila">{z.observaciones}</div>}
                  </td>
                  <td>{z.nombre}</td>
                  <td>
                    <div className="acciones">
                      <button className="chico" onClick={() => setZona(z)} disabled={guardando}>
                        Editar
                      </button>
                      {confirmando === z.id ? (
                        <>
                          <button
                            className="chico peligro"
                            disabled={guardando}
                            onClick={() => ejecutar(() => borrarZona(z.id))}
                          >
                            Confirmar
                          </button>
                          <button className="chico" onClick={() => setConfirmando(null)}>
                            No
                          </button>
                        </>
                      ) : (
                        <button
                          className="chico peligro"
                          onClick={() => setConfirmando(z.id)}
                          disabled={guardando}
                        >
                          Borrar
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Los límites siguen viviendo en su propia pestaña. Acá va sólo el
          recordatorio de que el excedente se deriva a un Punto Verde, que es lo
          que ata las dos pantallas. */}
      {limites.some((l) => (l.texto_exceso ?? "").toLowerCase().includes("punto verde")) && (
        <p className="ayuda" style={{ marginTop: 26, maxWidth: "70ch" }}>
          Ojo que los textos de exceso de <strong>Límites</strong> mandan al vecino a un Punto
          Verde. Si borrás todos los de acá, esos mensajes quedan sin destino.
        </p>
      )}

      {pv !== undefined && (
        <CajonPuntoVerde
          fila={pv}
          guardando={guardando}
          alCerrar={() => setPv(undefined)}
          alGuardar={(e) => ejecutar(() => guardarPuntoVerde(e))}
        />
      )}

      {zona !== undefined && (
        <CajonZona
          fila={zona}
          guardando={guardando}
          alCerrar={() => setZona(undefined)}
          alGuardar={(e) => ejecutar(() => guardarZona(e))}
        />
      )}
    </>
  );
}

/** «lunes, martes y viernes» — la misma forma que arma el dominio. */
function enumerar(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`;
}

/* ------------------------------------------------------------- cajones --- */

function CajonPuntoVerde({
  fila,
  guardando,
  alCerrar,
  alGuardar,
}: {
  fila: FilaPuntoVerde | null;
  guardando: boolean;
  alCerrar: () => void;
  alGuardar: (e: {
    id: string | null;
    nombre: string;
    direccion: string;
    tipo: string;
    horario: string;
    materiales: string;
    observaciones: string;
    orden: string;
    activo: boolean;
  }) => void;
}) {
  const [nombre, setNombre] = useState(fila?.nombre ?? "");
  const [direccion, setDireccion] = useState(fila?.direccion ?? "");
  const [tipo, setTipo] = useState(fila?.tipo ?? "contenedor");
  const [horario, setHorario] = useState(fila?.horario ?? "24 hs");
  const [materiales, setMateriales] = useState((fila?.materiales ?? []).join(", "));
  const [observaciones, setObservaciones] = useState(fila?.observaciones ?? "");
  const [orden, setOrden] = useState(String(fila?.orden ?? 100));
  const [activo, setActivo] = useState(fila?.activo ?? true);

  return (
    <>
      <div className="velo" onClick={alCerrar} aria-hidden="true" />
      <aside className="cajon" role="dialog" aria-modal="true" aria-label="Punto Verde">
        <div className="cajon-cabecera">
          <h2>{fila ? "Editar Punto Verde" : "Nuevo Punto Verde"}</h2>
          <button className="chico" onClick={alCerrar}>
            Cerrar
          </button>
        </div>

        <div className="cajon-cuerpo">
          <div className="campo">
            <label htmlFor="pv-dir">Dirección</label>
            <input
              id="pv-dir"
              type="text"
              value={direccion}
              onChange={(e) => setDireccion(e.target.value)}
              placeholder="Lamadrid 3700"
            />
            <p className="ayuda">
              Es lo único de esta ficha que el vecino escucha. Escribila como se la dirías por
              teléfono.
            </p>
          </div>

          <div className="campo">
            <label htmlFor="pv-horario">Horario</label>
            <input
              id="pv-horario"
              type="text"
              value={horario}
              onChange={(e) => setHorario(e.target.value)}
              placeholder="24 hs"
            />
            <p className="ayuda">También se dice. Va pegado a la dirección con un guion.</p>
          </div>

          {/* La vista previa usa el mismo globo que la pantalla de textos: es lo
              que convierte «cargué los campos» en «esto es lo que va a escuchar». */}
          <div className="campo">
            <label>Así lo va a decir Migue</label>
            <div className="vista-previa">
              • {direccion.trim() || "(falta la dirección)"} — {horario.trim() || "24 hs"}
              {observaciones.trim() ? ` (${observaciones.trim()})` : ""}
            </div>
          </div>

          <div className="campo">
            <label htmlFor="pv-nombre">Nombre</label>
            <input
              id="pv-nombre"
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Punto Verde Lamadrid"
            />
            <p className="ayuda">Sólo para reconocerlo en esta tabla. El vecino no lo escucha.</p>
          </div>

          <div className="campo">
            <label htmlFor="pv-obs">Aclaración</label>
            <input
              id="pv-obs"
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              placeholder="frente a la plaza"
            />
            <p className="ayuda">Opcional. Si la ponés, sale entre paréntesis después del horario.</p>
          </div>

          <div className="campo">
            <label htmlFor="pv-tipo">Tipo</label>
            <select id="pv-tipo" value={tipo} onChange={(e) => setTipo(e.target.value)}>
              <option value="contenedor">Contenedor</option>
              <option value="asistido">Asistido</option>
              <option value="movil">Móvil</option>
            </select>
            <p className="ayuda">Para el registro del área. Hoy no cambia lo que Migue dice.</p>
          </div>

          <div className="campo">
            <label htmlFor="pv-mat">Materiales</label>
            <input
              id="pv-mat"
              type="text"
              value={materiales}
              onChange={(e) => setMateriales(e.target.value)}
              placeholder="papel, carton, plastico, vidrio"
            />
            <p className="ayuda">Separados por coma. Para el registro del área.</p>
          </div>

          <div className="campo">
            <label htmlFor="pv-orden">Orden</label>
            <input
              id="pv-orden"
              type="text"
              value={orden}
              onChange={(e) => setOrden(e.target.value)}
            />
            <p className="ayuda">Menor primero. Es el orden en que Migue los enumera.</p>
          </div>

          <div className="campo">
            <label>
              <input
                type="checkbox"
                checked={activo}
                onChange={(e) => setActivo(e.target.checked)}
                style={{ width: "auto", marginRight: 8 }}
              />
              Activo
            </label>
            <p className="ayuda">Desactivado deja de nombrarse, sin borrarse.</p>
          </div>
        </div>

        <div className="cajon-pie">
          <button onClick={alCerrar}>Cancelar</button>
          <button
            className="primario"
            disabled={guardando}
            onClick={() =>
              alGuardar({
                id: fila?.id ?? null,
                nombre,
                direccion,
                tipo,
                horario,
                materiales,
                observaciones,
                orden,
                activo,
              })
            }
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </aside>
    </>
  );
}

function CajonZona({
  fila,
  guardando,
  alCerrar,
  alGuardar,
}: {
  fila: FilaZona | null;
  guardando: boolean;
  alCerrar: () => void;
  alGuardar: (e: {
    id: string | null;
    nombre: string;
    dias: string[];
    horaSacar: string;
    observaciones: string;
    activo: boolean;
  }) => void;
}) {
  const [nombre, setNombre] = useState(fila?.nombre ?? "");
  const [dias, setDias] = useState<string[]>(fila?.dias ?? []);
  const [horaSacar, setHoraSacar] = useState(fila?.hora_sacar ?? "");
  const [observaciones, setObservaciones] = useState(fila?.observaciones ?? "");
  const [activo, setActivo] = useState(fila?.activo ?? true);

  // En orden de semana, no en el que se tocaron los casilleros: la respuesta al
  // vecino dice «lunes, martes y viernes», y «viernes, lunes y martes» se lee
  // como un error aunque los días sean los correctos.
  const enOrden = DIAS_SEMANA.filter((d) => dias.includes(d));

  return (
    <>
      <div className="velo" onClick={alCerrar} aria-hidden="true" />
      <aside className="cajon" role="dialog" aria-modal="true" aria-label="Zona de recolección">
        <div className="cajon-cabecera">
          <h2>{fila ? "Editar zona" : "Nueva zona"}</h2>
          <button className="chico" onClick={alCerrar}>
            Cerrar
          </button>
        </div>

        <div className="cajon-cuerpo">
          <div className="campo">
            <label htmlFor="z-nombre">Nombre de la zona</label>
            <input
              id="z-nombre"
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Zona Norte"
            />
            <p className="ayuda">
              Este sí se escucha: Migue dice «Zona Norte: lunes, martes y viernes». Poné el nombre
              con el que el vecino reconoce su barrio.
            </p>
          </div>

          <div className="campo">
            <label>Días</label>
            <div className="dias-semana">
              {DIAS_SEMANA.map((d) => (
                <label key={d} className={dias.includes(d) ? "elegido" : ""}>
                  <input
                    type="checkbox"
                    checked={dias.includes(d)}
                    onChange={(e) =>
                      setDias((antes) =>
                        e.target.checked ? [...antes, d] : antes.filter((x) => x !== d),
                      )
                    }
                  />
                  {DIA_LEGIBLE[d]}
                </label>
              ))}
            </div>
            <p className="ayuda">Se guardan y se dicen en orden de semana, no en el que los toques.</p>
          </div>

          <div className="campo">
            <label htmlFor="z-hora">A qué hora sacar</label>
            <input
              id="z-hora"
              type="text"
              value={horaSacar}
              onChange={(e) => setHoraSacar(e.target.value)}
              placeholder="14:30 hs"
            />
            <p className="ayuda">Opcional. Si la ponés, se dice después de los días.</p>
          </div>

          <div className="campo">
            <label>Así lo va a decir Migue</label>
            <div className="vista-previa">
              • {nombre.trim() || "(falta el nombre)"}:{" "}
              {enOrden.length > 0
                ? enOrden.length === 1
                  ? enOrden[0]
                  : `${enOrden.slice(0, -1).join(", ")} y ${enOrden.at(-1)}`
                : "(falta elegir días)"}
              {horaSacar.trim() ? `, sacar a las ${horaSacar.trim()}` : ""}
            </div>
          </div>

          <div className="campo">
            <label htmlFor="z-obs">Aclaración</label>
            <input
              id="z-obs"
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
            />
            <p className="ayuda">
              Para el registro del área. Hoy no entra en lo que Migue dice, sólo se ve acá.
            </p>
          </div>

          <div className="campo">
            <label>
              <input
                type="checkbox"
                checked={activo}
                onChange={(e) => setActivo(e.target.checked)}
                style={{ width: "auto", marginRight: 8 }}
              />
              Activa
            </label>
          </div>
        </div>

        <div className="cajon-pie">
          <button onClick={alCerrar}>Cancelar</button>
          <button
            className="primario"
            disabled={guardando}
            onClick={() =>
              alGuardar({ id: fila?.id ?? null, nombre, dias, horaSacar, observaciones, activo })
            }
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </aside>
    </>
  );
}
