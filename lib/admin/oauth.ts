// Servidor de autorización OAuth 2.1 de un solo usuario para el conector MCP de claude.ai.
//
// - Registro dinámico (RFC 7591) sin estado: el client_id es un token firmado con sus redirect_uris.
// - Solo se acepta el callback de claude.ai.
// - /authorize muestra una página propia que pide la ADMIN_API_KEY (nunca llega al artifact).
// - Código de autorización y tokens firmados con HMAC; PKCE S256 obligatorio.
// - El refresco rota el refresh token (el anterior sigue siendo válido hasta caducar:
//   sin estado no se puede revocar uno suelto; rotar ADMIN_API_KEY los revoca todos).
import {
  REDIRECT_URIS,
  SCOPE,
  SCOPES_ADMITIDOS,
  TTL_ACCESO_S,
  TTL_CODIGO_S,
  TTL_REFRESCO_S,
  baseUrl,
  claveAdmin,
  urlMetadatosRecurso,
  urlRecurso,
} from "./config.ts";
import { ahora, firmar, igualSeguro, pkceValido, verificar } from "./firma.ts";

const SIN_CACHE = { "Cache-Control": "no-store", Pragma: "no-cache" };
const MAX_CUERPO = 16 * 1024;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...SIN_CACHE, ...extra },
  });
}

// ---------------------------------------------------------------------------
// Metadatos
// ---------------------------------------------------------------------------
export function metadatosRecurso(): Response {
  return json(200, {
    resource: urlRecurso(),
    authorization_servers: [baseUrl()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Encuestas de fecha · Comisión de Fiestas de Jorcas 2027",
  });
}

export function metadatosServidor(): Response {
  const b = baseUrl();
  return json(200, {
    issuer: b,
    authorization_endpoint: `${b}/api/oauth/authorize`,
    token_endpoint: `${b}/api/oauth/token`,
    registration_endpoint: `${b}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES_ADMITIDOS],
    authorization_response_iss_parameter_supported: true,
  });
}

/** 401 que apunta a los metadatos del recurso (así Claude descubre el servidor de autorización). */
export function noAutorizado(tokenPresente: boolean): Response {
  const partes = [`resource_metadata="${urlMetadatosRecurso()}"`, `scope="${SCOPE}"`];
  if (tokenPresente) partes.unshift(`error="invalid_token"`);
  return new Response(null, {
    status: 401,
    headers: { "WWW-Authenticate": `Bearer ${partes.join(", ")}`, ...SIN_CACHE },
  });
}

/** null si el Bearer es un token de acceso válido para este recurso; si no, la respuesta 401. */
export function exigirBearer(req: Request): Response | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/.exec(h);
  if (!m) return noAutorizado(false);
  const carga = verificar(m[1], "at");
  if (!carga || carga.aud !== urlRecurso()) return noAutorizado(true);
  return null;
}

// ---------------------------------------------------------------------------
// Registro dinámico de clientes (RFC 7591)
// ---------------------------------------------------------------------------
export async function registrar(req: Request): Promise<Response> {
  if (!claveAdmin()) return json(503, { error: "temporarily_unavailable" });
  const cuerpo = await leerJson(req);
  if (!cuerpo) return json(400, { error: "invalid_client_metadata" });

  const ru = cuerpo.redirect_uris;
  if (!Array.isArray(ru) || ru.length === 0 || ru.length > 5 || !ru.every((u) => typeof u === "string" && (REDIRECT_URIS as readonly string[]).includes(u))) {
    return json(400, { error: "invalid_redirect_uri", error_description: "redirect_uri no permitido" });
  }
  const gt = cuerpo.grant_types;
  if (gt !== undefined && (!Array.isArray(gt) || !gt.every((g) => g === "authorization_code" || g === "refresh_token"))) {
    return json(400, { error: "invalid_client_metadata" });
  }
  const rt = cuerpo.response_types;
  if (rt !== undefined && (!Array.isArray(rt) || !rt.every((r) => r === "code"))) {
    return json(400, { error: "invalid_client_metadata" });
  }
  const nombre = typeof cuerpo.client_name === "string" ? cuerpo.client_name.slice(0, 100) : undefined;
  const redirects = [...new Set(ru as string[])];

  return json(201, {
    client_id: firmar("cid", { ru: redirects }),
    client_id_issued_at: ahora(),
    redirect_uris: redirects,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(nombre ? { client_name: nombre } : {}),
  });
}

// ---------------------------------------------------------------------------
// /authorize
// ---------------------------------------------------------------------------
type Peticion = {
  clientId: string;
  redirectUri: string;
  state: string | null;
  challenge: string;
  scope: string;
  resource: string | null;
};

type Validacion =
  | { ok: true; p: Peticion }
  | { ok: false; redirigible: false; motivo: string }
  | { ok: false; redirigible: true; redirectUri: string; state: string | null; error: string };

function validarPeticion(get: (k: string) => string | null): Validacion {
  const clientId = get("client_id") ?? "";
  const redirectUri = get("redirect_uri") ?? "";
  const cliente = verificar(clientId, "cid");
  const registrados = Array.isArray(cliente?.ru) ? (cliente!.ru as unknown[]) : [];
  if (!cliente) return { ok: false, redirigible: false, motivo: "Cliente no reconocido." };
  if (!(REDIRECT_URIS as readonly string[]).includes(redirectUri) || !registrados.includes(redirectUri)) {
    return { ok: false, redirigible: false, motivo: "Dirección de retorno no permitida." };
  }
  const state = get("state");
  if (state !== null && state.length > 1024) return { ok: false, redirigible: false, motivo: "Petición no válida." };

  const fallo = (error: string): Validacion => ({ ok: false, redirigible: true, redirectUri, state, error });
  if (get("response_type") !== "code") return fallo("unsupported_response_type");
  const challenge = get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || get("code_challenge_method") !== "S256") return fallo("invalid_request");
  const scopes = (get("scope") ?? SCOPE).split(" ").filter(Boolean);
  if (scopes.length === 0 || !scopes.every((s) => (SCOPES_ADMITIDOS as readonly string[]).includes(s))) return fallo("invalid_scope");
  const resource = get("resource");
  if (resource !== null && resource !== urlRecurso()) return fallo("invalid_target");

  return { ok: true, p: { clientId, redirectUri, state, challenge, scope: [...new Set(scopes)].join(" "), resource } };
}

function redirigir(redirectUri: string, params: Record<string, string | null>): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), ...SIN_CACHE } });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function pagina(status: number, cuerpo: string): Response {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Acceso de administración · Encuestas Jorcas 2027</title>
<style>
:root{color-scheme:light dark;--bg:#fbf7f0;--fg:#2a2420;--muted:#6b6058;--line:#ddd3c6;--acc:#9c3d1b;--err:#a32020}
@media(prefers-color-scheme:dark){:root{--bg:#1a1714;--fg:#eee6dc;--muted:#b0a59a;--line:#3a332d;--acc:#e08a5f;--err:#f08080}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;margin:12vh auto;padding:0 16px;display:flex;flex-direction:column;gap:14px}
h1{font-size:20px;margin:0}p{margin:0}.muted{color:var(--muted);font-size:14px}
label{display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:14px}
input{font:inherit;padding:10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
button{font:inherit;font-weight:600;padding:10px 14px;border:0;border-radius:6px;background:var(--acc);color:#fff;cursor:pointer}
.err{color:var(--err);font-weight:600}.host{font-family:ui-monospace,monospace}
</style></head><body><main>${cuerpo}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...SIN_CACHE, "X-Frame-Options": "DENY" },
  });
}

function formulario(p: Peticion, error: string | null): Response {
  const host = new URL(p.redirectUri).host;
  const ocultos: [string, string | null][] = [
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["state", p.state],
    ["code_challenge", p.challenge],
    ["code_challenge_method", "S256"],
    ["response_type", "code"],
    ["scope", p.scope],
    ["resource", p.resource],
  ];
  return pagina(
    error ? 401 : 200,
    `<h1>Conectar las encuestas con Claude</h1>
<p><b class="host">${esc(host)}</b> pide acceso de administración a las encuestas de fecha: crear encuestas, ver votos y enlaces de los invitados, cerrar y convocar.</p>
<p class="muted">Solo autoriza si lo estás conectando tú desde claude.ai.</p>
<form method="post" action="/api/oauth/authorize">
${ocultos.filter(([, v]) => v !== null).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v!)}">`).join("\n")}
<label>Clave de administración (ADMIN_API_KEY)<input type="password" name="clave" autocomplete="current-password" required autofocus></label>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<p style="margin-top:12px"><button type="submit">Autorizar</button></p>
</form>`,
  );
}

export function autorizarGet(req: Request): Response {
  if (!claveAdmin()) return pagina(503, "<h1>No disponible</h1><p>El acceso de administración no está configurado.</p>");
  const url = new URL(req.url);
  const v = validarPeticion((k) => url.searchParams.get(k));
  if (!v.ok) {
    if (v.redirigible) return redirigir(v.redirectUri, { error: v.error, state: v.state, iss: baseUrl() });
    return pagina(400, `<h1>Petición no válida</h1><p>${esc(v.motivo)}</p>`);
  }
  return formulario(v.p, null);
}

export async function autorizarPost(req: Request): Promise<Response> {
  const clave = claveAdmin();
  if (!clave) return pagina(503, "<h1>No disponible</h1><p>El acceso de administración no está configurado.</p>");
  if (!mismoOrigen(req)) return pagina(403, "<h1>Petición no válida</h1>");
  const form = await leerFormulario(req);
  if (!form) return pagina(400, "<h1>Petición no válida</h1>");
  const v = validarPeticion((k) => form.get(k));
  if (!v.ok) {
    if (v.redirigible) return redirigir(v.redirectUri, { error: v.error, state: v.state, iss: baseUrl() });
    return pagina(400, `<h1>Petición no válida</h1><p>${esc(v.motivo)}</p>`);
  }
  const intento = form.get("clave") ?? "";
  if (!igualSeguro(intento, clave)) return formulario(v.p, "Clave incorrecta.");

  const code = firmar("code", { cid: v.p.clientId, ru: v.p.redirectUri, cc: v.p.challenge, sc: v.p.scope }, TTL_CODIGO_S);
  return redirigir(v.p.redirectUri, { code, state: v.p.state, iss: baseUrl() });
}

// ---------------------------------------------------------------------------
// /token
// ---------------------------------------------------------------------------
function emitir(clientId: string, scope: string): Response {
  const aud = urlRecurso();
  return json(200, {
    access_token: firmar("at", { aud, cid: clientId, sc: scope }, TTL_ACCESO_S),
    token_type: "Bearer",
    expires_in: TTL_ACCESO_S,
    refresh_token: firmar("rt", { aud, cid: clientId, sc: scope }, TTL_REFRESCO_S),
    scope,
  });
}

export async function token(req: Request): Promise<Response> {
  if (!claveAdmin()) return json(503, { error: "temporarily_unavailable" });
  const form = await leerFormulario(req);
  if (!form) return json(400, { error: "invalid_request" });
  const resource = form.get("resource");
  if (resource !== null && resource !== urlRecurso()) return json(400, { error: "invalid_target" });
  const clientId = form.get("client_id");

  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const c = verificar(form.get("code"), "code");
    if (!c) return json(400, { error: "invalid_grant" });
    if (!clientId || clientId !== c.cid) return json(400, { error: "invalid_grant" });
    if (form.get("redirect_uri") !== c.ru) return json(400, { error: "invalid_grant" });
    if (!pkceValido(form.get("code_verifier"), c.cc)) return json(400, { error: "invalid_grant" });
    if (!verificar(clientId, "cid")) return json(401, { error: "invalid_client" });
    return emitir(clientId, String(c.sc));
  }
  if (grant === "refresh_token") {
    const r = verificar(form.get("refresh_token"), "rt");
    if (!r || r.aud !== urlRecurso()) return json(400, { error: "invalid_grant" });
    if (clientId !== null && clientId !== r.cid) return json(400, { error: "invalid_grant" });
    if (!verificar(r.cid, "cid")) return json(400, { error: "invalid_grant" });
    return emitir(String(r.cid), String(r.sc));
  }
  return json(400, { error: "unsupported_grant_type" });
}

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------
async function leerTexto(req: Request): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_CUERPO) return null;
  const t = await req.text().catch(() => null);
  return t !== null && t.length <= MAX_CUERPO ? t : null;
}

async function leerFormulario(req: Request): Promise<URLSearchParams | null> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/x-www-form-urlencoded")) return null;
  const t = await leerTexto(req);
  if (t === null) return null;
  const p = new URLSearchParams(t);
  // Parámetros repetidos = petición ambigua.
  const vistos = new Set<string>();
  for (const k of p.keys()) {
    if (vistos.has(k)) return null;
    vistos.add(k);
  }
  return p;
}

async function leerJson(req: Request): Promise<Record<string, unknown> | null> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) return null;
  const t = await leerTexto(req);
  if (t === null) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function mismoOrigen(req: Request): boolean {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    try {
      if (new URL(origin).host !== new URL(req.url).host && new URL(origin).origin !== baseUrl()) return false;
    } catch {
      return false;
    }
  }
  return true;
}
