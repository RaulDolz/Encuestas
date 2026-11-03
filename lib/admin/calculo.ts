// Cálculo puro del detalle de una encuesta (sin acceso a BD): recuentos, matriz y líder.
import { enlaceComun, esEmailFicticio } from "../comun-codigo.ts";

export type FilaEncuesta = {
  id: string;
  titulo: string;
  descripcion: string | null;
  cierre: string;
  estado: "abierta" | "cerrada" | "convocada";
  ganadora_opcion_id: string | null;
  evento_outlook_id: string | null;
  creada_at: string | null;
};
export type FilaOpcion = { id: string; inicio: string; fin: string; orden: number | null };
export type FilaInvitado = {
  id: string;
  nombre: string | null;
  email: string;
  token: string;
  enviado_at: string | null;
  respondio_at: string | null;
};
export type FilaVoto = { invitado_id: string; opcion_id: string; disponible: boolean };

export type Detalle = ReturnType<typeof calcularDetalle>;

export function enlaceVoto(base: string, encuestaId: string, token: string): string {
  return `${base}/e/${encuestaId}?t=${encodeURIComponent(token)}`;
}

export function calcularDetalle(
  enc: FilaEncuesta,
  opciones: FilaOpcion[],
  invitados: FilaInvitado[],
  votos: FilaVoto[],
  base: string,
  ahoraMs = Date.now(),
) {
  const ordenadas = [...opciones].sort(
    (a, b) => (a.orden ?? Number.MAX_SAFE_INTEGER) - (b.orden ?? Number.MAX_SAFE_INTEGER) || Date.parse(a.inicio) - Date.parse(b.inicio),
  );
  const ids = new Set(ordenadas.map((o) => o.id));
  const porInvitado = new Map<string, Record<string, boolean>>();
  const disponibles = new Map<string, number>();
  for (const v of votos) {
    if (!ids.has(v.opcion_id)) continue;
    const m = porInvitado.get(v.invitado_id) ?? {};
    m[v.opcion_id] = v.disponible;
    porInvitado.set(v.invitado_id, m);
    if (v.disponible) disponibles.set(v.opcion_id, (disponibles.get(v.opcion_id) ?? 0) + 1);
  }

  const inv = [...invitados]
    .sort((a, b) => (a.nombre ?? a.email).localeCompare(b.nombre ?? b.email, "es"))
    .map((i) => {
      const votosI = porInvitado.get(i.id) ?? {};
      const respondido = i.respondio_at !== null || Object.keys(votosI).length > 0;
      return {
        id: i.id,
        nombre: i.nombre,
        /** null si se dio de alta sin email (en la BD hay uno ficticio). */
        email: esEmailFicticio(i.email) ? null : i.email,
        enlace: enlaceVoto(base, enc.id, i.token),
        enviado_at: i.enviado_at,
        respondio_at: i.respondio_at,
        respondido,
        votos: votosI,
      };
    });

  const opc = ordenadas.map((o) => ({ id: o.id, inicio: o.inicio, fin: o.fin, orden: o.orden, disponibles: disponibles.get(o.id) ?? 0 }));
  const max = opc.reduce((m, o) => Math.max(m, o.disponibles), 0);
  const top = max > 0 ? opc.filter((o) => o.disponibles === max).map((o) => o.id) : [];
  const respondidos = inv.filter((i) => i.respondido).length;

  return {
    id: enc.id,
    titulo: enc.titulo,
    descripcion: enc.descripcion,
    cierre: enc.cierre,
    estado: enc.estado,
    cierre_vencido: Date.parse(enc.cierre) <= ahoraMs,
    creada_at: enc.creada_at,
    ganadora_opcion_id: enc.ganadora_opcion_id,
    evento_outlook_id: enc.evento_outlook_id,
    /** Enlace único para todos: cada uno elige su nombre o se añade. null si falta ADMIN_API_KEY. */
    enlace_comun: enlaceComun(base, enc.id),
    opciones: opc,
    invitados: inv,
    total_invitados: inv.length,
    respondidos,
    pendientes: inv.length - respondidos,
    lider: { disponibles: max, opciones: top, empate: top.length > 1 },
  };
}

export function resumenLista(
  encuestas: Pick<FilaEncuesta, "id" | "titulo" | "estado" | "cierre" | "creada_at">[],
  invitados: { encuesta_id: string; respondio_at: string | null }[],
) {
  const cuenta = new Map<string, { n: number; r: number }>();
  for (const i of invitados) {
    const c = cuenta.get(i.encuesta_id) ?? { n: 0, r: 0 };
    c.n++;
    if (i.respondio_at) c.r++;
    cuenta.set(i.encuesta_id, c);
  }
  return [...encuestas]
    .sort((a, b) => String(b.creada_at ?? "").localeCompare(String(a.creada_at ?? "")))
    .map((e) => ({
      id: e.id,
      titulo: e.titulo,
      estado: e.estado,
      cierre: e.cierre,
      creada_at: e.creada_at,
      invitados: cuenta.get(e.id)?.n ?? 0,
      respondidos: cuenta.get(e.id)?.r ?? 0,
    }));
}
