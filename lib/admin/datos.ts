import "server-only";
import { getSupabase } from "../supabase.ts";
import { CODIGOS_NEGOCIO, ErrorDatos } from "./mcp.ts";
import type { Datos } from "./mcp.ts";
import type { FilaEncuesta, FilaInvitado, FilaOpcion, FilaVoto } from "./calculo.ts";

/** Convierte un error de Supabase en ErrorDatos sin registrar mensajes (podrían llevar valores). */
function fallo(contexto: string, error: { code?: string; message?: string }): never {
  const msg = error.message ?? "";
  if (CODIGOS_NEGOCIO.has(msg)) throw new ErrorDatos(msg);
  console.error(`[admin] error en ${contexto}`, { code: error.code });
  throw new ErrorDatos("error_interno");
}

export const datosSupabase: Datos = {
  async crear(e) {
    const { data, error } = await getSupabase().rpc("admin_crear_encuesta", {
      p_titulo: e.titulo,
      p_descripcion: e.descripcion,
      p_cierre: e.cierre,
      p_opciones: e.opciones,
      p_invitados: e.invitados,
    });
    if (error) fallo("admin_crear_encuesta", error);
    const r = data as { id: string; invitados: { nombre: string | null; email: string; token: string }[] };
    return { id: r.id, invitados: r.invitados };
  },

  async listar() {
    const sb = getSupabase();
    const [e, i] = await Promise.all([
      sb.from("encuestas").select("id, titulo, estado, cierre, creada_at").order("creada_at", { ascending: false }).limit(500),
      sb.from("invitados").select("encuesta_id, respondio_at").limit(20000),
    ]);
    if (e.error) fallo("listar encuestas", e.error);
    if (i.error) fallo("listar invitados", i.error);
    return {
      encuestas: (e.data ?? []) as Pick<FilaEncuesta, "id" | "titulo" | "estado" | "cierre" | "creada_at">[],
      invitados: (i.data ?? []) as { encuesta_id: string; respondio_at: string | null }[],
    };
  },

  async detalle(id) {
    const sb = getSupabase();
    const [e, o, i] = await Promise.all([
      sb.from("encuestas")
        .select("id, titulo, descripcion, cierre, estado, ganadora_opcion_id, evento_outlook_id, creada_at")
        .eq("id", id).maybeSingle(),
      sb.from("opciones").select("id, inicio, fin, orden").eq("encuesta_id", id),
      sb.from("invitados").select("id, nombre, email, token, enviado_at, respondio_at").eq("encuesta_id", id),
    ]);
    for (const r of [e, o, i]) if (r.error) fallo("detalle", r.error);
    if (!e.data) return null;
    const opciones = (o.data ?? []) as FilaOpcion[];
    let votos: FilaVoto[] = [];
    if (opciones.length) {
      const v = await sb.from("votos").select("invitado_id, opcion_id, disponible").in("opcion_id", opciones.map((x) => x.id));
      if (v.error) fallo("detalle votos", v.error);
      votos = (v.data ?? []) as FilaVoto[];
    }
    return { encuesta: e.data as FilaEncuesta, opciones, invitados: (i.data ?? []) as FilaInvitado[], votos };
  },

  async cerrar(id) {
    const { data, error } = await getSupabase().rpc("admin_cerrar_encuesta", { p_encuesta: id });
    if (error) fallo("admin_cerrar_encuesta", error);
    return String(data);
  },

  async convocar(id, opcionId, evento) {
    const { error } = await getSupabase().rpc("admin_convocar_encuesta", { p_encuesta: id, p_opcion: opcionId, p_evento: evento });
    if (error) fallo("admin_convocar_encuesta", error);
  },

  async marcarEnviados(id, emails) {
    const sb = getSupabase();
    const ex = await sb.from("encuestas").select("id").eq("id", id).maybeSingle();
    if (ex.error) fallo("marcar enviados", ex.error);
    if (!ex.data) throw new ErrorDatos("encuesta_no_encontrada");
    const { data, error } = await sb
      .from("invitados")
      .update({ enviado_at: new Date().toISOString() })
      .eq("encuesta_id", id)
      .in("email", emails)
      .select("email");
    if (error) fallo("marcar enviados", error);
    return ((data ?? []) as { email: string }[]).map((r) => r.email);
  },

  async borrar(id) {
    // Las FK de opciones, invitados y votos son ON DELETE CASCADE (0001).
    const { data, error } = await getSupabase().from("encuestas").delete().eq("id", id).select("id");
    if (error) fallo("borrar encuesta", error);
    return ((data ?? []) as { id: string }[]).length > 0;
  },
};
