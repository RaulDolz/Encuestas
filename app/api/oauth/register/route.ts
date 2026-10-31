import { registrar } from "@/lib/admin/oauth.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return registrar(request);
}
