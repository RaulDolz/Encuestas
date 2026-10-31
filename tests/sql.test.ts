// Migraciones 0001-0004 contra Postgres real (PGlite, en memoria). No toca Supabase.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const MIG = ["0001_esquema.sql", "0002_registrar_votos.sql", "0003_invitado_por_token.sql", "0004_admin.sql"];
const sql = (f: string) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8");

let db: PGlite;

const futuro = (dias: number, hora = "20:00") => {
  const d = new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);
  return `${d}T${hora}:00+01:00`;
};

async function crear(args: { titulo?: string; desc?: string | null; cierre?: string; opciones?: unknown; invitados?: unknown }) {
  const r = await db.query<{ r: { id: string; opciones: { id: string }[]; invitados: { id: string; email: string; token: string; nombre: string | null }[] } }>(
    `select public.admin_crear_encuesta($1, $2, $3::timestamptz, $4::jsonb, $5::jsonb) as r`,
    [
      args.titulo ?? "Fecha de la 3ª reunión",
      args.desc ?? null,
      args.cierre ?? futuro(3),
      JSON.stringify(args.opciones ?? [{ inicio: futuro(10), fin: futuro(10, "21:00") }, { inicio: futuro(11), fin: futuro(11, "21:00") }]),
      JSON.stringify(args.invitados ?? [{ email: " Ana@Example.com ", nombre: "Ana" }, { email: "luis@example.com" }]),
    ],
  );
  return r.rows[0].r;
}

async function errorDe(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return "sin_error";
}

const contar = async () =>
  (await db.query<{ e: number; o: number; i: number }>(
    `select (select count(*)::int from encuestas) e, (select count(*)::int from opciones) o, (select count(*)::int from invitados) i`,
  )).rows[0];

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create role service_role;`);
  for (const f of MIG) await db.exec(sql(f));
});

test("0004 es re-ejecutable", async () => {
  await db.exec(sql("0004_admin.sql"));
  await db.exec(sql("0004_admin.sql"));
});

test("solo service_role puede ejecutar las funciones admin", async () => {
  const r = await db.query<{ f: string; anon: boolean; auth: boolean; sr: boolean; definer: boolean }>(`
    select p.proname f,
           has_function_privilege('anon', p.oid, 'execute') anon,
           has_function_privilege('authenticated', p.oid, 'execute') auth,
           has_function_privilege('service_role', p.oid, 'execute') sr,
           p.prosecdef definer
      from pg_proc p where p.proname like 'admin\\_%' order by 1`);
  assert.equal(r.rows.length, 3);
  for (const row of r.rows) {
    assert.equal(row.anon, false, row.f);
    assert.equal(row.auth, false, row.f);
    assert.equal(row.sr, true, row.f);
    assert.equal(row.definer, true, row.f);
  }
});

test("crear: inserta todo, normaliza emails y genera tokens de 48 hex", async () => {
  const antes = await contar();
  const r = await crear({});
  const despues = await contar();
  assert.deepEqual([despues.e - antes.e, despues.o - antes.o, despues.i - antes.i], [1, 2, 2]);
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(r.invitados.map((i) => i.email), ["ana@example.com", "luis@example.com"]);
  assert.equal(r.invitados[0].nombre, "Ana");
  assert.equal(r.invitados[1].nombre, null);
  for (const i of r.invitados) assert.match(i.token, /^[0-9a-f]{48}$/);
  const ord = await db.query<{ orden: number }>(`select orden from opciones where encuesta_id = $1 order by orden`, [r.id]);
  assert.deepEqual(ord.rows.map((x) => x.orden), [1, 2]);
});

test("crear: el token generado sirve para votar con registrar_votos", async () => {
  const r = await crear({});
  await db.query(`select public.registrar_votos($1, $2, $3::jsonb)`, [
    r.id,
    r.invitados[0].token,
    JSON.stringify([{ opcion_id: r.opciones[0].id, disponible: true }]),
  ]);
  const v = await db.query<{ n: number }>(`select count(*)::int n from votos where opcion_id = $1 and disponible`, [r.opciones[0].id]);
  assert.equal(v.rows[0].n, 1);
});

test("crear: un invitado inválido no deja nada escrito (transacción)", async () => {
  const antes = await contar();
  const err = await errorDe(crear({ invitados: [{ email: "bien@example.com" }, { email: "no-es-un-email" }] }));
  assert.equal(err, "invitados_invalidos");
  assert.deepEqual(await contar(), antes);
});

test("crear: validaciones", async () => {
  const casos: [string, Parameters<typeof crear>[0]][] = [
    ["titulo_invalido", { titulo: "   " }],
    ["titulo_invalido", { titulo: "x".repeat(201) }],
    ["descripcion_invalida", { desc: "x".repeat(2001) }],
    ["cierre_invalido", { cierre: "2020-01-01T10:00:00+01:00" }],
    ["opciones_invalidas", { opciones: [] }],
    ["opciones_invalidas", { opciones: [{ inicio: futuro(5), fin: futuro(5, "19:00") }] }], // fin < inicio
    ["opciones_invalidas", { opciones: [{ inicio: "2020-01-01T10:00:00+01:00", fin: "2020-01-01T11:00:00+01:00" }] }],
    ["opciones_invalidas", { opciones: [{ inicio: futuro(5).slice(0, 19), fin: futuro(5, "21:00").slice(0, 19) }] }], // sin offset
    ["opciones_invalidas", { opciones: [{ inicio: futuro(5), fin: futuro(5, "21:00"), extra: 1 }] }],
    ["opciones_invalidas", { opciones: [{ inicio: futuro(5), fin: futuro(5, "21:00") }, { inicio: futuro(5), fin: futuro(5, "21:00") }] }],
    ["opciones_invalidas", { opciones: [{ inicio: "2026-13-40T10:00:00+01:00", fin: "2026-13-40T11:00:00+01:00" }] }],
    ["invitados_invalidos", { invitados: [] }],
    ["invitados_invalidos", { invitados: [{ email: "a@example.com" }, { email: "A@EXAMPLE.COM " }] }],
    ["invitados_invalidos", { invitados: [{ email: "a@example.com", nombre: "x".repeat(101) }] }],
    ["invitados_invalidos", { invitados: [{ email: "a@example.com", rol: "x" }] }],
    ["invitados_invalidos", { invitados: [{ email: "a@example.com", nombre: 5 }] }],
  ];
  const antes = await contar();
  for (const [codigo, args] of casos) {
    assert.equal(await errorDe(crear(args)), codigo, JSON.stringify(args));
  }
  assert.deepEqual(await contar(), antes);
});

test("crear: respeta el offset horario (cambio de hora)", async () => {
  const r = await crear({
    opciones: [{ inicio: "2027-03-28T12:00:00+02:00", fin: "2027-03-28T13:00:00+02:00" }],
  });
  const o = await db.query<{ utc: string }>(
    `select to_char(inicio at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') utc from opciones where encuesta_id = $1`,
    [r.id],
  );
  assert.equal(o.rows[0].utc, "2027-03-28T10:00");
});

test("cerrar: abierta -> cerrada, idempotente, y no existe -> error", async () => {
  const r = await crear({});
  const e1 = await db.query<{ e: string }>(`select public.admin_cerrar_encuesta($1) e`, [r.id]);
  const e2 = await db.query<{ e: string }>(`select public.admin_cerrar_encuesta($1) e`, [r.id]);
  assert.equal(e1.rows[0].e, "cerrada");
  assert.equal(e2.rows[0].e, "cerrada");
  assert.equal(
    await errorDe(db.query(`select public.admin_cerrar_encuesta($1)`, ["00000000-0000-0000-0000-000000000000"])),
    "encuesta_no_encontrada",
  );
  // Ya no admite votos.
  assert.equal(
    await errorDe(db.query(`select public.registrar_votos($1, $2, $3::jsonb)`, [
      r.id, r.invitados[0].token, JSON.stringify([{ opcion_id: r.opciones[0].id, disponible: true }]),
    ])),
    "encuesta_cerrada",
  );
});

test("convocar: exige cerrada y opción de la misma encuesta", async () => {
  const a = await crear({});
  const b = await crear({});
  const conv = (enc: string, op: string | null, ev: string | null) =>
    db.query(`select public.admin_convocar_encuesta($1, $2, $3)`, [enc, op, ev]);

  assert.equal(await errorDe(conv(a.id, a.opciones[0].id, null)), "encuesta_abierta");
  await db.query(`select public.admin_cerrar_encuesta($1)`, [a.id]);
  assert.equal(await errorDe(conv(a.id, b.opciones[0].id, null)), "opcion_invalida");
  assert.equal(await errorDe(conv(a.id, null, null)), "opcion_invalida");
  assert.equal(await errorDe(conv(a.id, a.opciones[1].id, "con espacios")), "evento_invalido");

  await conv(a.id, a.opciones[1].id, "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AJRPi-CGgl06vFV1rWKtEcAAJfejEWAAA");
  const r = await db.query<{ estado: string; ganadora_opcion_id: string; evento_outlook_id: string }>(
    `select estado, ganadora_opcion_id, evento_outlook_id from encuestas where id = $1`,
    [a.id],
  );
  assert.equal(r.rows[0].estado, "convocada");
  assert.equal(r.rows[0].ganadora_opcion_id, a.opciones[1].id);
  assert.ok(r.rows[0].evento_outlook_id.startsWith("AAkAL"));

  // Re-convocar (p. ej. tras cancelar el evento) está permitido.
  await conv(a.id, a.opciones[0].id, null);
  const r2 = await db.query<{ ganadora_opcion_id: string; evento_outlook_id: string | null }>(
    `select ganadora_opcion_id, evento_outlook_id from encuestas where id = $1`,
    [a.id],
  );
  assert.equal(r2.rows[0].ganadora_opcion_id, a.opciones[0].id);
  assert.equal(r2.rows[0].evento_outlook_id, null);
});
