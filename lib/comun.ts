import "server-only";
import { getSupabase } from "./supabase";
import { fechaHoraLarga, textoOpcion } from "./fechas";
import type { Estado } from "./encuestas";

// Entrada por enlace común (/e/<id>?c=<código>): lista de nombres para elegir,
// alta de quien no está y resultados de solo lectura. Nunca selecciona email ni
// token de nadie para mostrar; el token solo sale por token_de_invitado/alta_invitado_comun
// para guardarlo en la cookie de quien entra.

export type NombreEntrada = { id: string; etiqueta: string; respondido: boolean };

export type VistaEntrada = {
  encuestaId: string;
  titulo: string;
  descripcion: string | null;
  cierreTexto: string;
  estado: Estado;
  editable: boolean;
  ganadora: { dia: string; horas: string } | null;
  opciones: { id: string; dia: string; horas: string; corto: string; disponibles: number }[];
  nombres: NombreEntrada[];
  /** Solo quien ya ha respondido, en el orden de la lista. */
  participantes: { etiqueta: string; votos: Record<string, boolean> }[];
  respondidos: number;
};

function fallo(contexto: string, code: string | undefined): never {
  console.error(`[comun] error en ${contexto}`, { code });
  throw new Error("consulta_fallida");
}

export async function cargarEntrada(encuestaId: string): Promise<VistaEntrada | null> {
  const sb = getSupabase();
  const [encRes, opcRes, invRes] = await Promise.all([
    sb.from("encuestas").select("id, titulo, descripcion, cierre, estado, ganadora_opcion_id").eq("id", encuestaId).maybeSingle(),
    sb
      .from("opciones")
      .select("id, inicio, fin, orden")
      .eq("encuesta_id", encuestaId)
      .order("orden", { ascending: true, nullsFirst: false })
      .order("inicio", { ascending: true }),
    sb.from("invitados").select("id, nombre, respondio_at").eq("encuesta_id", encuestaId).order("id", { ascending: true }),
  ]);
  if (encRes.error) fallo("encuesta", encRes.error.code);
  if (opcRes.error) fallo("opciones", opcRes.error.code);
  if (invRes.error) fallo("invitados", invRes.error.code);
  const enc = encRes.data;
  if (!enc) return null;

  const opciones = (opcRes.data ?? []) as { id: string; inicio: string; fin: string }[];
  const invitados = (invRes.data ?? []) as { id: string; nombre: string | null; respondio_at: string | null }[];

  let votos: { invitado_id: string; opcion_id: string; disponible: boolean }[] = [];
  if (opciones.length > 0) {
    const v = await sb.from("votos").select("invitado_id, opcion_id, disponible").in("opcion_id", opciones.map((o) => o.id));
    if (v.error) fallo("votos", v.error.code);
    votos = v.data ?? [];
  }

  const porInvitado = new Map<string, Record<string, boolean>>();
  const disponibles = new Map<string, number>();
  for (const v of votos) {
    const m = porInvitado.get(v.invitado_id) ?? {};
    m[v.opcion_id] = v.disponible;
    porInvitado.set(v.invitado_id, m);
    if (v.disponible) disponibles.set(v.opcion_id, (disponibles.get(v.opcion_id) ?? 0) + 1);
  }

  // "Participante N" numera sobre la lista completa (orden estable por id), como la página de votación.
  const nombres: NombreEntrada[] = invitados.map((i, idx) => {
    const n = typeof i.nombre === "string" && i.nombre.trim() ? i.nombre.trim() : null;
    return { id: i.id, etiqueta: n ?? `Participante ${idx + 1}`, respondido: i.respondio_at !== null || porInvitado.has(i.id) };
  });
  const participantes = nombres
    .filter((n) => n.respondido)
    .map((n) => ({ etiqueta: n.etiqueta, votos: porInvitado.get(n.id) ?? {} }));
  nombres.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, "es", { sensitivity: "base", numeric: true }));
  participantes.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, "es", { sensitivity: "base", numeric: true }));

  const estado = enc.estado as Estado;
  let ganadora: VistaEntrada["ganadora"] = null;
  if (estado === "convocada" && enc.ganadora_opcion_id) {
    const g = opciones.find((o) => o.id === enc.ganadora_opcion_id);
    if (g) {
      const t = textoOpcion(g.inicio, g.fin);
      ganadora = { dia: t.dia, horas: t.horas };
    }
  }

  return {
    encuestaId: enc.id,
    titulo: enc.titulo,
    descripcion: enc.descripcion ?? null,
    cierreTexto: fechaHoraLarga(enc.cierre),
    estado,
    editable: estado === "abierta" && Date.now() < new Date(enc.cierre).getTime(),
    ganadora,
    opciones: opciones.map((o) => ({ id: o.id, ...textoOpcion(o.inicio, o.fin), disponibles: disponibles.get(o.id) ?? 0 })),
    nombres,
    participantes,
    respondidos: participantes.length,
  };
}

/** Token del invitado si es de esa encuesta; null si no. */
export async function tokenDeInvitado(encuestaId: string, invitadoId: string): Promise<string | null> {
  const { data, error } = await getSupabase().rpc("token_de_invitado", { p_encuesta: encuestaId, p_invitado: invitadoId });
  if (error) fallo("token_de_invitado", error.code);
  return typeof data === "string" && data ? data : null;
}

export const ERRORES_ALTA = ["nombre_invalido", "nombre_repetido", "encuesta_cerrada", "demasiados_invitados", "encuesta_no_encontrada"] as const;
export type ErrorAlta = (typeof ERRORES_ALTA)[number];

/** Da de alta a alguien por nombre. Devuelve el token o el código de error de negocio. */
export async function altaInvitado(encuestaId: string, nombre: string): Promise<{ token: string } | { error: ErrorAlta }> {
  const { data, error } = await getSupabase().rpc("alta_invitado_comun", { p_encuesta: encuestaId, p_nombre: nombre });
  if (error) {
    const m = error.message ?? "";
    if ((ERRORES_ALTA as readonly string[]).includes(m)) return { error: m as ErrorAlta };
    fallo("alta_invitado_comun", error.code);
  }
  const fila = Array.isArray(data) ? (data[0] as { token?: unknown } | undefined) : undefined;
  if (!fila || typeof fila.token !== "string") fallo("alta_invitado_comun (respuesta)", undefined);
  return { token: fila.token as string };
}
