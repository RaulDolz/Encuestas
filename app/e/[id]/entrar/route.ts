import { NextResponse, type NextRequest } from "next/server";
import { esUuid } from "@/lib/validacion";
import { codigoComunValido } from "@/lib/comun-codigo";
import { altaInvitado, tokenDeInvitado } from "@/lib/comun";
import { COOKIE_CODIGO, COOKIE_MAX_AGE, COOKIE_TOKEN, rutaEncuesta } from "@/lib/cookie";

/**
 * POST /e/<id>/entrar — formulario de la página del enlace común.
 * Campos: c (código), y o bien invitado (uuid, elegir nombre de la lista) o bien nombre (añadirse).
 * Fija la misma cookie de token que el enlace personal y redirige (303) a /e/<id>.
 * Errores: vuelve a /e/<id>?c=<c>&error=<código>.
 */
const MAX_BODY = 4 * 1024;

function mismoOrigen(request: NextRequest): boolean {
  const sfs = request.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
      if (!host || new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const ir = (ruta: string) => new NextResponse(null, { status: 303, headers: { Location: ruta, "Cache-Control": "no-store" } });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idCrudo } = await params;
  if (!esUuid(idCrudo)) return ir("/enlace-no-valido");
  const id = idCrudo.toLowerCase();
  if (!mismoOrigen(request)) return ir("/enlace-no-valido");

  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/x-www-form-urlencoded")) return ir("/enlace-no-valido");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY) return ir("/enlace-no-valido");

  let form: URLSearchParams;
  try {
    const texto = await request.text();
    if (texto.length > MAX_BODY) return ir("/enlace-no-valido");
    form = new URLSearchParams(texto);
  } catch {
    return ir("/enlace-no-valido");
  }

  const c = form.get("c");
  if (!codigoComunValido(id, c)) return ir("/enlace-no-valido");
  const volver = (error: string) => ir(`${rutaEncuesta(id)}?c=${c}&error=${error}`);

  const invitado = form.get("invitado");
  const nombre = form.get("nombre");

  let token: string | null = null;
  try {
    if (invitado) {
      if (!esUuid(invitado)) return volver("persona_no_valida");
      token = await tokenDeInvitado(id, invitado.toLowerCase());
      if (!token) return volver("persona_no_valida");
    } else if (nombre !== null) {
      const r = await altaInvitado(id, nombre);
      if ("error" in r) return volver(r.error);
      token = r.token;
    } else {
      return volver("persona_no_valida");
    }
  } catch {
    // El detalle (solo el código) ya está en el log del servidor.
    return ir("/no-disponible");
  }

  const ruta = rutaEncuesta(id);
  const res = ir(ruta);
  const comunes = { httpOnly: true, secure: true, sameSite: "lax" as const, path: ruta, maxAge: COOKIE_MAX_AGE };
  res.cookies.set({ name: COOKIE_TOKEN, value: token, ...comunes });
  res.cookies.set({ name: COOKIE_CODIGO, value: c, ...comunes });
  return res;
}
