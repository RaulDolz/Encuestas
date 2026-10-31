import { manejarMcp } from "@/lib/admin/mcp.ts";
import { datosSupabase } from "@/lib/admin/datos.ts";

/**
 * Servidor MCP de administración (conector personalizado de claude.ai).
 * Streamable HTTP sin estado: solo POST con respuestas JSON. Requiere un token
 * de acceso OAuth emitido por /api/oauth/token.
 */
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return manejarMcp(request, datosSupabase);
}

const noPermitido = () =>
  new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });

export const GET = noPermitido;
export const DELETE = noPermitido;
