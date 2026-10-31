import { autorizarGet, autorizarPost } from "@/lib/admin/oauth.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return autorizarGet(request);
}

export function POST(request: Request) {
  return autorizarPost(request);
}
