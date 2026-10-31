import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { esToken, esUuid, parsearVotos } from "@/lib/validacion";
import { COOKIE_TOKEN } from "@/lib/cookie";

/**
 * POST /e/<id>/votar  — body: { votos: [{ opcion_id, disponible }] }
 *
 * Vive bajo /e/<id> (y no en /api/votar) para que el navegador envíe la cookie
 * del token, que tiene Path=/e/<id>. El token se lee SOLO de la cookie.
 */
const MAX_BODY = 32 * 1024;

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function mismoOrigen(request: NextRequest): boolean {
  const sfs = request.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
      if (!host || new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!esUuid(id)) return json(404, { error: "no_encontrada" });

  if (!mismoOrigen(request)) return json(403, { error: "origen_no_permitido" });

  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) return json(415, { error: "tipo_no_soportado" });

  const token = request.cookies.get(COOKIE_TOKEN)?.value;
  if (!esToken(token)) return json(403, { error: "token_invalido" });

  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return json(413, { error: "demasiado_grande" });

  let body: unknown;
  try {
    const texto = await request.text();
    if (texto.length > MAX_BODY) return json(413, { error: "demasiado_grande" });
    body = JSON.parse(texto);
  } catch {
    return json(400, { error: "votos_invalidos" });
  }

  const votos = parsearVotos(body);
  if (!votos) return json(400, { error: "votos_invalidos" });

  let sb;
  try {
    sb = getSupabase();
  } catch {
    return json(503, { error: "no_disponible" });
  }

  const { error } = await sb.rpc("registrar_votos", {
    p_encuesta: id.toLowerCase(),
    p_token: token,
    p_votos: votos,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg === "token_invalido") return json(403, { error: "token_invalido" });
    if (msg === "encuesta_cerrada") return json(409, { error: "encuesta_cerrada" });
    if (msg === "opcion_invalida" || msg === "votos_invalidos") return json(400, { error: msg });
    // Solo el código: el mensaje de PostgREST podría incluir valores.
    console.error("[votar] error en registrar_votos", { code: error.code });
    return json(500, { error: "error_interno" });
  }

  return json(200, { ok: true });
}
