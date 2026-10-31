"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { VistaEncuesta } from "@/lib/encuestas";

type Estado =
  | { tipo: "inicial" }
  | { tipo: "guardando" }
  | { tipo: "ok"; hora: string }
  | { tipo: "error"; texto: string };

const horaAhora = () =>
  new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" }).format(
    new Date(),
  );

export default function Votacion({ vista }: { vista: VistaEncuesta }) {
  const router = useRouter();
  const [seleccion, setSeleccion] = useState<Record<string, boolean>>(() => ({ ...vista.misVotos }));
  const [estado, setEstado] = useState<Estado>({ tipo: "inicial" });

  const editable = vista.editable;
  // En solo lectura se muestra lo que hay en BD, no cambios locales que no llegaron a guardarse.
  const votosMostrados = editable ? seleccion : vista.misVotos;

  const conteos = useMemo(() => {
    const c: Record<string, number> = {};
    for (const o of vista.opciones) c[o.id] = o.disponiblesOtros + (votosMostrados[o.id] === true ? 1 : 0);
    return c;
  }, [vista.opciones, votosMostrados]);

  const maximo = Math.max(0, ...Object.values(conteos));
  const respondidas = vista.opciones.filter((o) => typeof seleccion[o.id] === "boolean").length;
  const pendientes = vista.opciones.length - respondidas;

  const hayCambios = vista.opciones.some((o) => seleccion[o.id] !== vista.misVotos[o.id]);

  function marcar(opcionId: string, valor: boolean) {
    if (!editable) return;
    setSeleccion((s) => ({ ...s, [opcionId]: valor }));
    if (estado.tipo !== "guardando") setEstado({ tipo: "inicial" });
  }

  async function guardar() {
    const votos = vista.opciones
      .filter((o) => typeof seleccion[o.id] === "boolean")
      .map((o) => ({ opcion_id: o.id, disponible: seleccion[o.id] }));
    if (votos.length === 0) return;

    setEstado({ tipo: "guardando" });
    try {
      const res = await fetch(`/e/${vista.encuestaId}/votar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ votos }),
      });
      if (res.ok) {
        setEstado({ tipo: "ok", hora: horaAhora() });
        router.refresh();
        return;
      }
      if (res.status === 409) {
        setEstado({ tipo: "error", texto: "La votación ya está cerrada. No se han guardado los cambios." });
        router.refresh();
        return;
      }
      if (res.status === 403) {
        setEstado({ tipo: "error", texto: "Tu enlace ya no es válido. Vuelve a abrirlo desde el correo." });
        return;
      }
      setEstado({ tipo: "error", texto: "No se ha podido guardar. Inténtalo de nuevo." });
    } catch {
      setEstado({ tipo: "error", texto: "Sin conexión. Inténtalo de nuevo." });
    }
  }

  return (
    <main className="contenedor">
      <header className="cabecera">
        <p className="marca">Comisión de Fiestas de Jorcas 2027</p>
        {vista.nombre ? <p className="saludo">Hola, {vista.nombre}</p> : null}
        <h1>{vista.titulo}</h1>
        {vista.descripcion ? <p className="descripcion">{vista.descripcion}</p> : null}
        <p className="cierre">
          {editable ? "Se puede votar hasta el " : "Cierre: "}
          <strong>{vista.cierreTexto.replace(/^./, (c) => (editable ? c.toLowerCase() : c))}</strong>
        </p>
      </header>

      {!editable ? (
        <section className="banda-cerrada" role="status">
          <p className="banda-titulo">Votación cerrada</p>
          {vista.estado === "convocada" && vista.ganadora ? (
            <p>
              Fecha elegida: <strong>{vista.ganadora.dia}</strong>, {vista.ganadora.horas}
            </p>
          ) : null}
        </section>
      ) : (
        <p className="instrucciones">Marca en cada fecha si te va bien o no y pulsa «Guardar mi disponibilidad».</p>
      )}

      <ol className="tarjetas">
        {vista.opciones.map((o) => {
          const v = votosMostrados[o.id];
          const destacada = maximo > 0 && conteos[o.id] === maximo;
          return (
            <li key={o.id} className={`tarjeta${destacada ? " destacada" : ""}`}>
              <div className="tarjeta-fecha">
                <p className="dia">{o.dia}</p>
                <p className="horas">{o.horas}</p>
              </div>
              <div className="tarjeta-pie">
                {editable ? (
                  <div className="segmentado" role="group" aria-label={`Disponibilidad para ${o.dia}`}>
                    <button
                      type="button"
                      className={`seg si${v === true ? " activo" : ""}`}
                      aria-pressed={v === true}
                      onClick={() => marcar(o.id, true)}
                    >
                      Me va bien
                    </button>
                    <button
                      type="button"
                      className={`seg no${v === false ? " activo" : ""}`}
                      aria-pressed={v === false}
                      onClick={() => marcar(o.id, false)}
                    >
                      No me va bien
                    </button>
                  </div>
                ) : (
                  <p className="mi-voto">
                    Tu respuesta:{" "}
                    <strong>{v === true ? "Me va bien" : v === false ? "No me va bien" : "Sin responder"}</strong>
                  </p>
                )}
                <p className="contador" aria-label={`${conteos[o.id]} personas disponibles`}>
                  <span className="contador-num">{conteos[o.id]}</span>{" "}
                  {conteos[o.id] === 1 ? "disponible" : "disponibles"}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {vista.opciones.length > 0 ? (
        <section className="doodle" aria-label="Disponibilidad de los participantes">
          <h2>Participantes</h2>
          <div className="doodle-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col" className="col-nombre">
                    Participante
                  </th>
                  {vista.opciones.map((o) => (
                    <th scope="col" key={o.id} title={`${o.dia}, ${o.horas}`}>
                      {o.corto}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vista.participantes.map((p, i) => (
                  <tr key={i} className={p.yo ? "fila-yo" : undefined}>
                    <th scope="row" className="col-nombre">
                      {p.etiqueta}
                      {p.yo ? <span className="tu"> (tú)</span> : null}
                    </th>
                    {vista.opciones.map((o) => {
                      const valor = p.yo ? votosMostrados[o.id] : p.votos[o.id];
                      if (p.yo && editable) {
                        return (
                          <td key={o.id}>
                            <button
                              type="button"
                              className={`celda-btn ${valor === true ? "si" : valor === false ? "no" : "vacio"}`}
                              aria-pressed={valor === true}
                              aria-label={`${o.dia}, ${o.horas}: ${valor === true ? "me va bien" : valor === false ? "no me va bien" : "sin responder"}`}
                              onClick={() => marcar(o.id, valor !== true)}
                            >
                              {valor === true ? "✓" : valor === false ? "✕" : "·"}
                            </button>
                          </td>
                        );
                      }
                      return (
                        <td key={o.id} className={valor === true ? "si" : valor === false ? "no" : "vacio"}>
                          {valor === true ? "✓" : valor === false ? "✕" : "·"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" className="col-nombre">
                    Disponibles
                  </th>
                  {vista.opciones.map((o) => (
                    <td key={o.id} className={maximo > 0 && conteos[o.id] === maximo ? "max" : undefined}>
                      {conteos[o.id]}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      ) : null}

      {editable && vista.opciones.length > 0 ? (
        <div className="barra-guardar">
          <div className="barra-estado" aria-live="polite">
            {estado.tipo === "ok" && !hayCambios ? (
              <span className="ok">✓ Disponibilidad guardada a las {estado.hora}</span>
            ) : estado.tipo === "error" ? (
              <span className="err">{estado.texto}</span>
            ) : hayCambios ? (
              <span className="tenue">
                Cambios sin guardar{pendientes > 0 ? ` · ${pendientes} ${pendientes === 1 ? "fecha" : "fechas"} sin responder` : ""}
              </span>
            ) : pendientes > 0 ? (
              <span className="tenue">
                {pendientes} {pendientes === 1 ? "fecha" : "fechas"} sin responder
              </span>
            ) : (
              <span className="tenue">Puedes cambiar tu respuesta hasta el cierre.</span>
            )}
          </div>
          <button
            type="button"
            className="btn-guardar"
            onClick={guardar}
            disabled={estado.tipo === "guardando" || respondidas === 0}
          >
            {estado.tipo === "guardando" ? (
              <>
                <span className="spinner" aria-hidden="true" /> Guardando…
              </>
            ) : (
              "Guardar mi disponibilidad"
            )}
          </button>
        </div>
      ) : null}
    </main>
  );
}
