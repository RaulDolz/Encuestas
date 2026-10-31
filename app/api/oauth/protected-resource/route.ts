import { metadatosRecurso } from "@/lib/admin/oauth.ts";

/** Servido también en /.well-known/oauth-protected-resource[/api/mcp] (rewrite en next.config.ts). */
export const dynamic = "force-dynamic";

export function GET() {
  return metadatosRecurso();
}
