// Configuración del acceso de administración (OAuth + MCP).
// Sin "server-only" para poder probarlo con node:test; solo lo importan rutas de servidor.

/** URL pública de producción. Es la que se da de alta como conector en claude.ai. */
const BASE_URL_PRODUCCION = "https://comisionjorcas2027.vercel.app";

/** Único redirect_uri aceptado: el callback de las apps alojadas de Claude (web, escritorio, móvil). */
export const REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback"] as const;

export const SCOPE = "encuestas";
export const SCOPES_ADMITIDOS = [SCOPE, "offline_access"] as const;

export const TTL_CODIGO_S = 5 * 60;
export const TTL_ACCESO_S = 60 * 60;
export const TTL_REFRESCO_S = 30 * 24 * 60 * 60;

/** ≥ 32 bytes aleatorios: 43 caracteres base64url como mínimo. */
const LONGITUD_MINIMA_CLAVE = 43;

export function baseUrl(): string {
  const v = process.env.PUBLIC_BASE_URL?.trim();
  return (v && /^https?:\/\/[^/]+$/.test(v) ? v : BASE_URL_PRODUCCION).replace(/\/$/, "");
}

export function urlRecurso(): string {
  return `${baseUrl()}/api/mcp`;
}

export function urlMetadatosRecurso(): string {
  return `${baseUrl()}/.well-known/oauth-protected-resource/api/mcp`;
}

let avisado = false;

/** ADMIN_API_KEY o null si falta o es demasiado corta (en ese caso todo el acceso admin queda cerrado). */
export function claveAdmin(): string | null {
  const k = process.env.ADMIN_API_KEY?.trim();
  if (!k || k.length < LONGITUD_MINIMA_CLAVE) {
    if (!avisado) {
      console.error("[admin] ADMIN_API_KEY ausente o demasiado corta: acceso de administración desactivado");
      avisado = true;
    }
    return null;
  }
  return k;
}
