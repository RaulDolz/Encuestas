const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// El token por defecto son 48 hex (24 bytes). Se admite un rango algo más amplio
// por si el artifact de actas genera tokens con otro formato URL-safe.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function esUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function esToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN_RE.test(v);
}

export type VotoEntrada = { opcion_id: string; disponible: boolean };

export const MAX_OPCIONES = 200;

/** Valida el body de POST /e/[id]/votar. Devuelve null si no es válido. */
export function parsearVotos(body: unknown): VotoEntrada[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const votos = (body as { votos?: unknown }).votos;
  if (!Array.isArray(votos) || votos.length === 0 || votos.length > MAX_OPCIONES) return null;

  const vistos = new Set<string>();
  const salida: VotoEntrada[] = [];
  for (const v of votos) {
    if (typeof v !== "object" || v === null) return null;
    const { opcion_id, disponible } = v as Record<string, unknown>;
    if (!esUuid(opcion_id) || typeof disponible !== "boolean") return null;
    const id = opcion_id.toLowerCase();
    if (vistos.has(id)) return null;
    vistos.add(id);
    salida.push({ opcion_id: id, disponible });
  }
  return salida;
}
