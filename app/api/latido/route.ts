import { NextResponse, type NextRequest } from "next/server";
import { igualSeguro } from "@/lib/admin/firma";
import { getSupabase } from "@/lib/supabase";

/**
 * GET /api/latido — consulta mínima a la BD para que Supabase (plan gratuito) no pause
 * el proyecto por inactividad (lo hace tras ~7 días sin uso). La llama a diario la
 * tarea programada de Vercel definida en vercel.json.
 *
 * Vercel envía `Authorization: Bearer <CRON_SECRET>` si la variable existe; sin ella
 * (o con otro valor) responde 401. No devuelve ningún dato de la BD.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secreto = process.env.CRON_SECRET?.trim();
  const auth = request.headers.get("authorization") ?? "";
  if (!secreto || !igualSeguro(auth, `Bearer ${secreto}`)) {
    return NextResponse.json({ error: "no_autorizado" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const { error } = await getSupabase().from("encuestas").select("id", { head: true, count: "exact" }).limit(1);
    if (error) {
      console.error("[latido] error de Supabase", { code: error.code ?? "" });
      return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("[latido] excepción");
    return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
