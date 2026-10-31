import { NextResponse, type NextRequest } from "next/server";
import { invitadoPorToken } from "@/lib/encuestas";
import { esToken, esUuid } from "@/lib/validacion";
import { COOKIE_MAX_AGE, COOKIE_TOKEN, rutaEncuesta } from "@/lib/cookie";

/**
 * Entrada desde el enlace del correo: /e/<id>?t=<token>.
 * next.config.ts reescribe esa URL (solo si lleva ?t=) a este handler.
 * Valida el token, lo guarda en cookie httpOnly y redirige a /e/<id> sin token.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = request.nextUrl.searchParams.get("t");

  // Location relativa: no depende de qué host crea el runtime que tiene la petición.
  const destino = (ruta: string) =>
    new NextResponse(null, {
      status: 303,
      headers: { Location: ruta, "Cache-Control": "no-store" },
    });

  if (!esUuid(id) || !esToken(token)) return destino("/enlace-no-valido");

  let valido = false;
  try {
    valido = (await invitadoPorToken(id, token)) !== null;
  } catch {
    // El detalle ya está en el log del servidor (sin token).
    return destino("/no-disponible");
  }
  if (!valido) return destino("/enlace-no-valido");

  const ruta = rutaEncuesta(id.toLowerCase());
  const res = destino(ruta);
  res.cookies.set({
    name: COOKIE_TOKEN,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: ruta,
    maxAge: COOKIE_MAX_AGE,
  });
  return res;
}
