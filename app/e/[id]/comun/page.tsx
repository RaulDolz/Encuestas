import { cookies } from "next/headers";
import Link from "next/link";
import { esToken, esUuid } from "@/lib/validacion";
import { codigoComunValido } from "@/lib/comun-codigo";
import { cargarEntrada, type VistaEntrada } from "@/lib/comun";
import { invitadoPorToken } from "@/lib/encuestas";
import { COOKIE_TOKEN, rutaEncuesta } from "@/lib/cookie";
import { EnlaceNoValido, NoDisponible } from "@/components/Aviso";

// Página del enlace común: /e/<id>?c=<código> (next.config.ts reescribe aquí).
// Cada uno elige su nombre o se añade; los resultados se ven sin identificarse.

const MENSAJES: Record<string, string> = {
  nombre_invalido: "Escribe tu nombre (máximo 100 caracteres).",
  nombre_repetido: "Ya hay alguien con ese nombre en la lista. Si eres tú, elígelo arriba; si no, añade tu apellido.",
  encuesta_cerrada: "La votación ya está cerrada.",
  demasiados_invitados: "La encuesta ya tiene el máximo de participantes.",
  persona_no_valida: "Esa persona ya no está en la lista. Vuelve a elegir.",
  encuesta_no_encontrada: "Esta encuesta ya no existe.",
};

export default async function EntradaComun({ params, searchParams }: PageProps<"/e/[id]/comun">) {
  const { id: idCrudo } = await params;
  const sp = await searchParams;
  const c = typeof sp.c === "string" ? sp.c : undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;

  if (!esUuid(idCrudo)) return <EnlaceNoValido />;
  const id = idCrudo.toLowerCase();
  if (!codigoComunValido(id, c)) return <EnlaceNoValido />;

  let vista: VistaEntrada | null;
  let yaComo: string | null = null;
  try {
    vista = await cargarEntrada(id);
    const token = (await cookies()).get(COOKIE_TOKEN)?.value;
    if (vista && esToken(token)) {
      const inv = await invitadoPorToken(id, token);
      if (inv) yaComo = inv.nombre?.trim() || "ti";
    }
  } catch {
    return <NoDisponible />;
  }
  if (!vista) return <EnlaceNoValido />;

  const maximo = Math.max(0, ...vista.opciones.map((o) => o.disponibles));
  const disponiblesPor = (opcionId: string) =>
    vista.participantes.filter((p) => p.votos[opcionId] === true).map((p) => p.etiqueta);
  const accion = `${rutaEncuesta(id)}/entrar`;

  return (
    <main className="contenedor entrada">
      <header className="cabecera">
        <p className="marca">Comisión de Fiestas de Jorcas 2027</p>
        <h1>{vista.titulo}</h1>
        {vista.descripcion ? <p className="descripcion">{vista.descripcion}</p> : null}
        <p className="cierre">
          {vista.editable ? "Se puede votar hasta el " : "Cierre: "}
          <strong>{vista.cierreTexto.replace(/^./, (x) => (vista.editable ? x.toLowerCase() : x))}</strong>
        </p>
      </header>

      {error && MENSAJES[error] ? (
        <p className="aviso-error" role="alert">
          {MENSAJES[error]}
        </p>
      ) : null}

      {!vista.editable ? (
        <section className="banda-cerrada" role="status">
          <p className="banda-titulo">Votación cerrada</p>
          {vista.estado === "convocada" && vista.ganadora ? (
            <p>
              Fecha elegida: <strong>{vista.ganadora.dia}</strong>, {vista.ganadora.horas}
            </p>
          ) : null}
        </section>
      ) : (
        <section className="quien" aria-labelledby="quien-titulo">
          {yaComo ? (
            <div className="continuar">
              <p>
                En este dispositivo ya estás votando como <strong>{yaComo}</strong>.
              </p>
              <Link className="btn-guardar" href={rutaEncuesta(id)}>
                Continuar como {yaComo}
              </Link>
            </div>
          ) : null}

          <h2 id="quien-titulo">{yaComo ? "¿No eres tú? Elige tu nombre" : "¿Quién eres?"}</h2>
          {vista.nombres.length > 0 ? (
            <form method="post" action={accion} className="lista-nombres">
              <input type="hidden" name="c" value={c} />
              {vista.nombres.map((n) => (
                <button key={n.id} type="submit" name="invitado" value={n.id} className="btn-nombre">
                  <span>{n.etiqueta}</span>
                  {n.respondido ? <span className="marca-voto">ya ha votado</span> : null}
                </button>
              ))}
            </form>
          ) : null}

          <form method="post" action={accion} className="alta">
            <input type="hidden" name="c" value={c} />
            <label htmlFor="nombre">¿No estás en la lista? Escribe tu nombre</label>
            <div className="alta-fila">
              <input id="nombre" name="nombre" type="text" required maxLength={100} autoComplete="name" placeholder="Nombre y apellido" />
              <button type="submit" className="btn-secundario">
                Añadirme y votar
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="resultados" aria-labelledby="res-titulo">
        <h2 id="res-titulo">
          Resultados{" "}
          <span className="tenue">
            · {vista.respondidos} {vista.respondidos === 1 ? "persona ha votado" : "personas han votado"}
          </span>
        </h2>
        <ol className="tarjetas">
          {vista.opciones.map((o) => {
            const nombres = disponiblesPor(o.id);
            return (
              <li key={o.id} className={`tarjeta${maximo > 0 && o.disponibles === maximo ? " destacada" : ""}`}>
                <div className="tarjeta-fecha">
                  <p className="dia">{o.dia}</p>
                  <p className="horas">{o.horas}</p>
                </div>
                <div className="tarjeta-pie">
                  <p className="contador">
                    <span className="contador-num">{o.disponibles}</span> {o.disponibles === 1 ? "disponible" : "disponibles"}
                  </p>
                  {nombres.length > 0 ? <p className="quienes">{nombres.join(", ")}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>

        {vista.participantes.length > 0 ? (
          <div className="doodle" aria-label="Disponibilidad de los participantes">
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
                    <tr key={i}>
                      <th scope="row" className="col-nombre">
                        {p.etiqueta}
                      </th>
                      {vista.opciones.map((o) => {
                        const v = p.votos[o.id];
                        return (
                          <td key={o.id} className={v === true ? "si" : v === false ? "no" : "vacio"}>
                            {v === true ? "✓" : v === false ? "✕" : "·"}
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
                      <td key={o.id} className={maximo > 0 && o.disponibles === maximo ? "max" : undefined}>
                        {o.disponibles}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
