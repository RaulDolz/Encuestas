import "server-only";
import { getSupabase } from "./supabase";
import { esToken, esUuid } from "./validacion";
import { fechaHoraLarga, textoOpcion } from "./fechas";

export type Estado = "abierta" | "cerrada" | "convocada";

export type OpcionVista = {
  id: string;
  dia: string;
  horas: string;
  corto: string;
  /** Disponibles según BD, sin contar el voto del propio invitado. */
  disponiblesOtros: number;
};

export type ParticipanteVista = {
  etiqueta: string;
  yo: boolean;
  /** opcion_id -> disponible (ausente = sin respuesta) */
  votos: Record<string, boolean>;
};

export type VistaEncuesta = {
  encuestaId: string;
  titulo: string;
  descripcion: string | null;
  cierreTexto: string;
  estado: Estado;
  /** true solo si estado = 'abierta' y aún no ha pasado el cierre. */
  editable: boolean;
  nombre: string | null;
  ganadora: { dia: string; horas: string } | null;
  opciones: OpcionVista[];
  participantes: ParticipanteVista[];
  misVotos: Record<string, boolean>;
};

type Invitado = { id: string; nombre: string | null };

/** Devuelve el invitado si el token pertenece a la encuesta; null en cualquier otro caso. */
export async function invitadoPorToken(encuestaId: string, token: string): Promise<Invitado | null> {
  if (!esUuid(encuestaId) || !esToken(token)) return null;
  const { data, error } = await getSupabase()
    .from("invitados")
    .select("id, nombre")
    .eq("encuesta_id", encuestaId)
    .eq("token", token)
    .maybeSingle();
  if (error) {
    console.error("[encuestas] error buscando invitado", { code: error.code });
    throw new Error("consulta_fallida");
  }
  return data ?? null;
}

/**
 * Carga todo lo que necesita la página de votación. Nunca selecciona email ni
 * token de nadie: esos campos no salen de la base de datos.
 */
export async function cargarVista(encuestaId: string, token: string): Promise<VistaEncuesta | null> {
  const invitado = await invitadoPorToken(encuestaId, token);
  if (!invitado) return null;

  const sb = getSupabase();

  const [encRes, opcRes, invRes] = await Promise.all([
    sb
      .from("encuestas")
      .select("id, titulo, descripcion, cierre, estado, ganadora_opcion_id")
      .eq("id", encuestaId)
      .maybeSingle(),
    sb
      .from("opciones")
      .select("id, inicio, fin, orden")
      .eq("encuesta_id", encuestaId)
      .order("orden", { ascending: true, nullsFirst: false })
      .order("inicio", { ascending: true }),
    sb
      .from("invitados")
      .select("id, nombre, respondio_at")
      .eq("encuesta_id", encuestaId)
      .order("id", { ascending: true }),
  ]);

  for (const r of [encRes, opcRes, invRes]) {
    if (r.error) {
      console.error("[encuestas] error cargando vista", { code: r.error.code });
      throw new Error("consulta_fallida");
    }
  }
  const enc = encRes.data;
  if (!enc) return null;

  const opciones = opcRes.data ?? [];
  const invitados = invRes.data ?? [];
  const opcionIds = opciones.map((o) => o.id as string);

  let votos: { invitado_id: string; opcion_id: string; disponible: boolean }[] = [];
  if (opcionIds.length > 0) {
    const votRes = await sb
      .from("votos")
      .select("invitado_id, opcion_id, disponible")
      .in("opcion_id", opcionIds);
    if (votRes.error) {
      console.error("[encuestas] error cargando votos", { code: votRes.error.code });
      throw new Error("consulta_fallida");
    }
    votos = votRes.data ?? [];
  }

  // Votos por invitado.
  const porInvitado = new Map<string, Record<string, boolean>>();
  for (const v of votos) {
    const m = porInvitado.get(v.invitado_id) ?? {};
    m[v.opcion_id] = v.disponible;
    porInvitado.set(v.invitado_id, m);
  }

  // Disponibles por opción excluyendo al propio invitado (el cliente suma su selección local).
  const disponiblesOtros = new Map<string, number>();
  for (const v of votos) {
    if (v.disponible && v.invitado_id !== invitado.id) {
      disponiblesOtros.set(v.opcion_id, (disponiblesOtros.get(v.opcion_id) ?? 0) + 1);
    }
  }

  // Participantes: quien ha respondido o tiene votos, más el propio invitado.
  // "Participante N" numera sobre la lista completa de invitados (orden estable por id).
  const participantes: ParticipanteVista[] = [];
  invitados.forEach((inv, idx) => {
    const yo = inv.id === invitado.id;
    const v = porInvitado.get(inv.id);
    if (!yo && !inv.respondio_at && !v) return;
    const nombre = typeof inv.nombre === "string" && inv.nombre.trim() ? inv.nombre.trim() : null;
    participantes.push({
      etiqueta: nombre ?? `Participante ${idx + 1}`,
      yo,
      votos: v ?? {},
    });
  });
  // El propio invitado, primero.
  participantes.sort((a, b) => Number(b.yo) - Number(a.yo));

  const estado = enc.estado as Estado;
  const editable = estado === "abierta" && Date.now() < new Date(enc.cierre).getTime();

  let ganadora: VistaEncuesta["ganadora"] = null;
  if (estado === "convocada" && enc.ganadora_opcion_id) {
    const g = opciones.find((o) => o.id === enc.ganadora_opcion_id);
    if (g) {
      const t = textoOpcion(g.inicio, g.fin);
      ganadora = { dia: t.dia, horas: t.horas };
    }
  }

  const nombre = typeof invitado.nombre === "string" && invitado.nombre.trim() ? invitado.nombre.trim() : null;

  return {
    encuestaId: enc.id,
    titulo: enc.titulo,
    descripcion: enc.descripcion ?? null,
    cierreTexto: fechaHoraLarga(enc.cierre),
    estado,
    editable,
    nombre,
    ganadora,
    opciones: opciones.map((o) => {
      const t = textoOpcion(o.inicio, o.fin);
      return { id: o.id, ...t, disponiblesOtros: disponiblesOtros.get(o.id) ?? 0 };
    }),
    participantes,
    misVotos: porInvitado.get(invitado.id) ?? {},
  };
}
