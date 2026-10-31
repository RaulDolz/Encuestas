// OAuth + MCP de administración. Datos reales en PGlite con las migraciones 0001-0004.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const CLAVE = randomBytes(32).toString("base64url");
process.env.ADMIN_API_KEY = CLAVE;
process.env.PUBLIC_BASE_URL = "https://comisionjorcas2027.vercel.app";

const { manejarMcp, ErrorDatos } = await import("../lib/admin/mcp.ts");
const oauth = await import("../lib/admin/oauth.ts");
const { igualSeguro } = await import("../lib/admin/firma.ts");
const { calcularDetalle } = await import("../lib/admin/calculo.ts");
import type { Datos } from "../lib/admin/mcp.ts";

const BASE = "https://comisionjorcas2027.vercel.app";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

// ---------------------------------------------------------------------------
// Datos sobre PGlite (mismas funciones SQL que usa Supabase)
// ---------------------------------------------------------------------------
let db: PGlite;
const pgError = (e: unknown): never => {
  const m = (e as Error).message;
  throw new ErrorDatos(m);
};
const datos: Datos = {
  async crear(e) {
    const r = await db
      .query<{ r: { id: string; invitados: { nombre: string | null; email: string; token: string }[] } }>(
        `select public.admin_crear_encuesta($1,$2,$3::timestamptz,$4::jsonb,$5::jsonb) r`,
        [e.titulo, e.descripcion, e.cierre, JSON.stringify(e.opciones), JSON.stringify(e.invitados)],
      )
      .catch(pgError);
    return r.rows[0].r;
  },
  async listar() {
    const e = await db.query<{ id: string; titulo: string; estado: "abierta"; cierre: string; creada_at: string }>(
      `select id, titulo, estado, cierre::text, creada_at::text from encuestas`,
    );
    const i = await db.query<{ encuesta_id: string; respondio_at: string | null }>(`select encuesta_id, respondio_at::text from invitados`);
    return { encuestas: e.rows, invitados: i.rows };
  },
  async detalle(id) {
    const e = await db.query(`select id, titulo, descripcion, cierre::text, estado, ganadora_opcion_id, evento_outlook_id, creada_at::text from encuestas where id=$1`, [id]);
    if (!e.rows.length) return null;
    const o = await db.query(`select id, inicio::text, fin::text, orden from opciones where encuesta_id=$1`, [id]);
    const i = await db.query(`select id, nombre, email, token, enviado_at::text, respondio_at::text from invitados where encuesta_id=$1`, [id]);
    const v = await db.query(`select v.invitado_id, v.opcion_id, v.disponible from votos v join opciones o on o.id=v.opcion_id where o.encuesta_id=$1`, [id]);
    return { encuesta: e.rows[0], opciones: o.rows, invitados: i.rows, votos: v.rows } as Awaited<ReturnType<Datos["detalle"]>>;
  },
  async cerrar(id) {
    const r = await db.query<{ e: string }>(`select public.admin_cerrar_encuesta($1) e`, [id]).catch(pgError);
    return r.rows[0].e;
  },
  async convocar(id, op, ev) {
    await db.query(`select public.admin_convocar_encuesta($1,$2,$3)`, [id, op, ev]).catch(pgError);
  },
  async marcarEnviados(id, emails) {
    const r = await db.query<{ email: string }>(
      `update invitados set enviado_at=now() where encuesta_id=$1 and email = any($2::text[]) returning email`,
      [id, emails],
    );
    return r.rows.map((x) => x.email);
  },
};

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create role service_role;`);
  for (const f of ["0001_esquema.sql", "0002_registrar_votos.sql", "0003_invitado_por_token.sql", "0004_admin.sql"]) {
    await db.exec(readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8"));
  }
});

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------
const form = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });

async function registrarCliente(): Promise<string> {
  const r = await oauth.registrar(
    new Request(`${BASE}/api/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: "Claude", token_endpoint_auth_method: "none" }),
    }),
  );
  assert.equal(r.status, 201);
  return ((await r.json()) as { client_id: string }).client_id;
}

const verifier = randomBytes(40).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

function paramsAutorizar(clientId: string): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "estado-123",
    scope: "encuestas offline_access",
    resource: `${BASE}/api/mcp`,
  };
}

async function obtenerTokens(): Promise<{ access_token: string; refresh_token: string; clientId: string }> {
  const clientId = await registrarCliente();
  const r = await oauth.autorizarPost(
    form(`${BASE}/api/oauth/authorize`, { ...paramsAutorizar(clientId), clave: CLAVE }, { "sec-fetch-site": "same-origin", origin: "null" }),
  );
  assert.equal(r.status, 302);
  const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
  const t = await oauth.token(
    form(`${BASE}/api/oauth/token`, {
      grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: `${BASE}/api/mcp`,
    }),
  );
  assert.equal(t.status, 200);
  return { ...((await t.json()) as { access_token: string; refresh_token: string }), clientId };
}

let rpcId = 0;
async function rpc(token: string | null, method: string, params?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await manejarMcp(
    new Request(`${BASE}/api/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) }),
    datos,
  );
  const txt = await res.text();
  return { res, body: txt ? JSON.parse(txt) : null };
}

const futuro = (dias: number, hora = "22:00") => `${new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10)}T${hora}:00+01:00`;

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------
test("comparación en tiempo constante: iguales, distintos y longitudes distintas", () => {
  assert.equal(igualSeguro("abc", "abc"), true);
  assert.equal(igualSeguro("abc", "abd"), false);
  assert.equal(igualSeguro("abc", "abcd"), false);
});

test("metadatos de descubrimiento", async () => {
  const r = (await oauth.metadatosRecurso().json()) as Record<string, unknown>;
  assert.equal(r.resource, `${BASE}/api/mcp`);
  assert.deepEqual(r.authorization_servers, [BASE]);
  const s = (await oauth.metadatosServidor().json()) as Record<string, unknown>;
  assert.deepEqual(s.code_challenge_methods_supported, ["S256"]);
  assert.equal(s.registration_endpoint, `${BASE}/api/oauth/register`);
});

test("registro: solo admite el callback de claude.ai", async () => {
  const r = await oauth.registrar(
    new Request(`${BASE}/api/oauth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://evil.example.com/cb"] }),
    }),
  );
  assert.equal(r.status, 400);
});

test("authorize GET: muestra el formulario con el host de retorno; cliente falso -> 400 sin redirigir", async () => {
  const clientId = await registrarCliente();
  const ok = oauth.autorizarGet(new Request(`${BASE}/api/oauth/authorize?${new URLSearchParams(paramsAutorizar(clientId))}`));
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /claude\.ai/);
  assert.match(html, /type="password"/);

  const falso = oauth.autorizarGet(new Request(`${BASE}/api/oauth/authorize?${new URLSearchParams(paramsAutorizar("jc1.falso.firma"))}`));
  assert.equal(falso.status, 400);
  assert.equal(falso.headers.get("location"), null);

  const sinPkce = oauth.autorizarGet(new Request(`${BASE}/api/oauth/authorize?${new URLSearchParams({ ...paramsAutorizar(clientId), code_challenge_method: "plain" })}`));
  assert.equal(sinPkce.status, 302);
  assert.equal(new URL(sinPkce.headers.get("location")!).searchParams.get("error"), "invalid_request");
});

test("authorize POST: clave incorrecta -> 401 sin código; otro origen -> 403", async () => {
  const clientId = await registrarCliente();
  const mal = await oauth.autorizarPost(form(`${BASE}/api/oauth/authorize`, { ...paramsAutorizar(clientId), clave: "no" }, { "sec-fetch-site": "same-origin" }));
  assert.equal(mal.status, 401);
  assert.equal(mal.headers.get("location"), null);
  const cross = await oauth.autorizarPost(form(`${BASE}/api/oauth/authorize`, { ...paramsAutorizar(clientId), clave: CLAVE }, { "sec-fetch-site": "cross-site" }));
  assert.equal(cross.status, 403);
});

test("token: PKCE incorrecto, código reutilizado con otro cliente y refresco", async () => {
  const clientId = await registrarCliente();
  const r = await oauth.autorizarPost(form(`${BASE}/api/oauth/authorize`, { ...paramsAutorizar(clientId), clave: CLAVE }, { "sec-fetch-site": "same-origin" }));
  const loc = new URL(r.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, CALLBACK);
  assert.equal(loc.searchParams.get("state"), "estado-123");
  assert.equal(loc.searchParams.get("iss"), BASE);
  const code = loc.searchParams.get("code")!;

  const malVerifier = await oauth.token(form(`${BASE}/api/oauth/token`, {
    grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: randomBytes(40).toString("base64url"),
  }));
  assert.equal(malVerifier.status, 400);
  assert.equal(((await malVerifier.json()) as { error: string }).error, "invalid_grant");

  const otroCliente = await oauth.token(form(`${BASE}/api/oauth/token`, {
    grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: await registrarCliente(), code_verifier: verifier,
  }));
  assert.equal(otroCliente.status, 400);

  const t = await obtenerTokens();
  const ref = await oauth.token(form(`${BASE}/api/oauth/token`, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.clientId }));
  assert.equal(ref.status, 200);
  const nuevo = (await ref.json()) as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(nuevo.token_type, "Bearer");
  assert.notEqual(nuevo.refresh_token, t.refresh_token);
  assert.equal(ref.headers.get("cache-control"), "no-store");

  // Un token de refresco no sirve como token de acceso.
  const { res } = await rpc(t.refresh_token, "ping");
  assert.equal(res.status, 401);

  const json = await oauth.token(new Request(`${BASE}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(json.status, 400);
});

test("rotar ADMIN_API_KEY invalida los tokens emitidos", async () => {
  const t = await obtenerTokens();
  process.env.ADMIN_API_KEY = randomBytes(32).toString("base64url");
  const { res } = await rpc(t.access_token, "ping");
  assert.equal(res.status, 401);
  process.env.ADMIN_API_KEY = CLAVE;
  assert.equal((await rpc(t.access_token, "ping")).res.status, 200);
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------
test("MCP sin token -> 401 con resource_metadata; token falso -> 401 invalid_token", async () => {
  const sin = await rpc(null, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(sin.res.status, 401);
  const wa = sin.res.headers.get("www-authenticate")!;
  assert.match(wa, /resource_metadata="https:\/\/comisionjorcas2027\.vercel\.app\/\.well-known\/oauth-protected-resource\/api\/mcp"/);
  assert.equal(sin.body, null);

  const falso = await rpc("jc1.e30.AAAA", "ping");
  assert.equal(falso.res.status, 401);
  assert.match(falso.res.headers.get("www-authenticate")!, /invalid_token/);

  // La ADMIN_API_KEY directa tampoco vale como Bearer: solo tokens OAuth.
  assert.equal((await rpc(CLAVE, "ping")).res.status, 401);
});

test("MCP: initialize, tools/list, notificaciones, método desconocido, lotes y versión", async () => {
  const { access_token: at } = await obtenerTokens();
  const ini = await rpc(at, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(ini.res.status, 200);
  assert.equal(ini.body.result.protocolVersion, "2025-06-18");
  assert.equal(ini.res.headers.get("cache-control"), "no-store");

  const lista = await rpc(at, "tools/list");
  assert.deepEqual(
    lista.body.result.tools.map((t: { name: string }) => t.name).sort(),
    ["cerrar_encuesta", "convocar_encuesta", "crear_encuesta", "detalle_encuesta", "listar_encuestas", "marcar_enviados"],
  );

  const notif = await manejarMcp(new Request(`${BASE}/api/mcp`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${at}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }), datos);
  assert.equal(notif.status, 202);

  assert.equal((await rpc(at, "resources/list")).body.error.code, -32601);
  const lote = await manejarMcp(new Request(`${BASE}/api/mcp`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${at}` }, body: "[]",
  }), datos);
  assert.equal(lote.status, 400);
  assert.equal((await rpc(at, "ping", undefined, { "mcp-protocol-version": "1999-01-01" })).res.status, 400);
});

test("MCP: validación estricta de crear_encuesta (nada se escribe)", async () => {
  const { access_token: at } = await obtenerTokens();
  const base = {
    titulo: "Prueba", cierre: futuro(3),
    opciones: [{ inicio: futuro(10), fin: futuro(10, "23:00") }],
    invitados: [{ nombre: "Ana", email: "ana@example.com" }],
  };
  const casos: [string, unknown][] = [
    ["argumentos_invalidos", { ...base, extra: 1 }],
    ["titulo_invalido", { ...base, titulo: "" }],
    ["cierre_invalido", { ...base, cierre: "2026-11-20T20:00:00" }], // sin offset
    ["cierre_invalido", { ...base, cierre: "2020-11-20T20:00:00+01:00" }],
    ["opciones_invalidas", { ...base, opciones: [{ inicio: futuro(10), fin: futuro(10, "21:00") }] }],
    ["opciones_invalidas", { ...base, opciones: [{ inicio: "2027-02-31T10:00:00+01:00", fin: "2027-02-31T11:00:00+01:00" }] }],
    ["invitados_invalidos", { ...base, invitados: [{ email: "x" }] }],
    ["invitados_invalidos", { ...base, invitados: [{ email: "a@b.es" }, { email: "A@B.ES" }] }],
  ];
  const antes = (await db.query<{ n: number }>(`select count(*)::int n from encuestas`)).rows[0].n;
  for (const [codigo, args] of casos) {
    const r = await rpc(at, "tools/call", { name: "crear_encuesta", arguments: args });
    assert.equal(r.body.result.isError, true, JSON.stringify(args));
    assert.equal(r.body.result.structuredContent.error, codigo, JSON.stringify(args));
  }
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from encuestas`)).rows[0].n, antes);
});

test("MCP: flujo completo crear → votar → detalle → cerrar → convocar → enviados", async () => {
  const { access_token: at } = await obtenerTokens();
  const call = async (name: string, args: unknown) => (await rpc(at, "tools/call", { name, arguments: args })).body.result;

  const c = await call("crear_encuesta", {
    titulo: "Fecha 3ª reunión", descripcion: "Elegid", cierre: futuro(3),
    opciones: [{ inicio: futuro(10), fin: futuro(10, "23:00") }, { inicio: futuro(11), fin: futuro(11, "23:00") }],
    invitados: [{ nombre: "Ana", email: "Ana@Example.com" }, { nombre: null, email: "luis@example.com" }, { email: "eva@example.com" }],
  });
  assert.equal(c.isError, false);
  const { id, invitados } = c.structuredContent;
  for (const i of invitados) assert.match(i.enlace, new RegExp(`^${BASE}/e/${id}\\?t=[0-9a-f]{48}$`));

  // Dos votos reales con registrar_votos (la ruta pública no cambia).
  const det0 = (await call("detalle_encuesta", { id })).structuredContent;
  const [op1, op2] = det0.opciones.map((o: { id: string }) => o.id);
  const tok = (email: string) => new URL(invitados.find((i: { email: string }) => i.email === email).enlace).searchParams.get("t");
  await db.query(`select registrar_votos($1,$2,$3::jsonb)`, [id, tok("ana@example.com"), JSON.stringify([{ opcion_id: op1, disponible: true }, { opcion_id: op2, disponible: true }])]);
  await db.query(`select registrar_votos($1,$2,$3::jsonb)`, [id, tok("luis@example.com"), JSON.stringify([{ opcion_id: op1, disponible: false }, { opcion_id: op2, disponible: true }])]);

  const det = (await call("detalle_encuesta", { id })).structuredContent;
  assert.deepEqual(det.opciones.map((o: { disponibles: number }) => o.disponibles), [1, 2]);
  assert.equal(det.respondidos, 2);
  assert.equal(det.pendientes, 1);
  assert.deepEqual(det.lider, { disponibles: 2, opciones: [op2], empate: false });
  const luis = det.invitados.find((i: { email: string }) => i.email === "luis@example.com");
  assert.deepEqual(luis.votos, { [op1]: false, [op2]: true });

  const lista = (await call("listar_encuestas", {})).structuredContent.encuestas;
  const fila = lista.find((e: { id: string }) => e.id === id);
  assert.deepEqual([fila.invitados, fila.respondidos, fila.estado], [3, 2, "abierta"]);

  assert.equal((await call("convocar_encuesta", { id, opcion_id: op2 })).structuredContent.error, "encuesta_abierta");
  assert.equal((await call("cerrar_encuesta", { id })).structuredContent.estado, "cerrada");
  assert.equal((await call("cerrar_encuesta", { id })).structuredContent.estado, "cerrada");
  assert.equal((await call("convocar_encuesta", { id, opcion_id: det0.opciones[0].id.replace(/.$/, "0") })).structuredContent.error, "opcion_invalida");
  const conv = await call("convocar_encuesta", { id, opcion_id: op2, evento_outlook_id: "AAMkAD-test_id=" });
  assert.equal(conv.isError, false);
  assert.equal((await call("detalle_encuesta", { id })).structuredContent.estado, "convocada");

  const env = (await call("marcar_enviados", { id, emails: ["ANA@example.com", "nadie@example.com"] })).structuredContent;
  assert.deepEqual(env.marcados, ["ana@example.com"]);
  assert.deepEqual(env.no_encontrados, ["nadie@example.com"]);

  assert.equal((await call("detalle_encuesta", { id: "00000000-0000-0000-0000-000000000000" })).structuredContent.error, "encuesta_no_encontrada");
  assert.equal((await call("detalle_encuesta", { id: "no-uuid" })).structuredContent.error, "id_invalido");
});

test("cálculo: empate y sin votos", () => {
  const enc = { id: "e", titulo: "t", descripcion: null, cierre: "2026-01-01T00:00:00Z", estado: "cerrada" as const, ganadora_opcion_id: null, evento_outlook_id: null, creada_at: null };
  const ops = [{ id: "a", inicio: "2026-02-01T10:00:00Z", fin: "2026-02-01T11:00:00Z", orden: 1 }, { id: "b", inicio: "2026-02-02T10:00:00Z", fin: "2026-02-02T11:00:00Z", orden: 2 }];
  const invs = [{ id: "i1", nombre: "A", email: "a@x.es", token: "t1", enviado_at: null, respondio_at: "x" }, { id: "i2", nombre: "B", email: "b@x.es", token: "t2", enviado_at: null, respondio_at: "x" }];
  const empate = calcularDetalle(enc, ops, invs, [{ invitado_id: "i1", opcion_id: "a", disponible: true }, { invitado_id: "i2", opcion_id: "b", disponible: true }], BASE);
  assert.deepEqual(empate.lider, { disponibles: 1, opciones: ["a", "b"], empate: true });
  assert.equal(empate.cierre_vencido, true);
  const nada = calcularDetalle(enc, ops, invs, [], BASE);
  assert.deepEqual(nada.lider, { disponibles: 0, opciones: [], empate: false });
});
