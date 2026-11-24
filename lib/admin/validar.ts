// Validación estricta de los argumentos de las herramientas MCP.
// La base de datos vuelve a validarlo todo (migración 0004); esto da errores claros antes.
import { claveNombre, emailFicticio, esEmailFicticio } from "../comun-codigo.ts";
// (editar_encuesta: migración 0006)

export class ErrorEntrada extends Error {
  readonly codigo: string;
  constructor(codigo: string) {
    super(codigo);
    this.codigo = codigo;
    this.name = "ErrorEntrada";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO 8601 con offset explícito: la hora de Madrid llega con +01:00 / +02:00 según el cambio de hora. */
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
export const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[A-Za-z]{2,}$/;
const EVENTO_RE = /^[A-Za-z0-9+/=_-]{1,512}$/;

export const LIMITES = { opciones: 50, invitados: 200, titulo: 200, descripcion: 2000, nombre: 100 } as const;

function objeto(v: unknown, permitidas: string[], codigo: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ErrorEntrada(codigo);
  for (const k of Object.keys(v)) if (!permitidas.includes(k)) throw new ErrorEntrada(codigo);
  return v as Record<string, unknown>;
}

function uuid(v: unknown, codigo = "id_invalido"): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new ErrorEntrada(codigo);
  return v.toLowerCase();
}

function fecha(v: unknown, codigo: string): string {
  if (typeof v !== "string" || !ISO_OFFSET_RE.test(v) || Number.isNaN(Date.parse(v))) throw new ErrorEntrada(codigo);
  // Rechaza fechas que JS "corrige" (31 de febrero, 25:00...).
  const [d, t] = v.split("T");
  const [y, m, dd] = d.split("-").map(Number);
  const [hh, mi] = t.slice(0, 5).split(":").map(Number);
  if (m < 1 || m > 12 || dd < 1 || dd > new Date(Date.UTC(y, m, 0)).getUTCDate() || hh > 23 || mi > 59) throw new ErrorEntrada(codigo);
  return v;
}

export type NuevaEncuesta = {
  titulo: string;
  descripcion: string | null;
  cierre: string;
  opciones: { inicio: string; fin: string }[];
  invitados: { email: string; nombre: string | null }[];
};

export function validarCrear(args: unknown, ahoraMs = Date.now()): NuevaEncuesta {
  const a = objeto(args, ["titulo", "descripcion", "cierre", "opciones", "invitados"], "argumentos_invalidos");

  if (typeof a.titulo !== "string") throw new ErrorEntrada("titulo_invalido");
  const titulo = a.titulo.trim();
  if (!titulo || titulo.length > LIMITES.titulo) throw new ErrorEntrada("titulo_invalido");

  let descripcion: string | null = null;
  if (a.descripcion !== undefined && a.descripcion !== null) {
    if (typeof a.descripcion !== "string" || a.descripcion.trim().length > LIMITES.descripcion) throw new ErrorEntrada("descripcion_invalida");
    descripcion = a.descripcion.trim() || null;
  }

  const cierre = fecha(a.cierre, "cierre_invalido");
  if (Date.parse(cierre) <= ahoraMs) throw new ErrorEntrada("cierre_invalido");

  if (!Array.isArray(a.opciones) || a.opciones.length < 1 || a.opciones.length > LIMITES.opciones) throw new ErrorEntrada("opciones_invalidas");
  const vistas = new Set<string>();
  const opciones = a.opciones.map((o) => {
    const x = objeto(o, ["inicio", "fin"], "opciones_invalidas");
    const inicio = fecha(x.inicio, "opciones_invalidas");
    const fin = fecha(x.fin, "opciones_invalidas");
    const ti = Date.parse(inicio), tf = Date.parse(fin);
    if (tf <= ti || ti <= ahoraMs) throw new ErrorEntrada("opciones_invalidas");
    const k = `${ti}-${tf}`;
    if (vistas.has(k)) throw new ErrorEntrada("opciones_invalidas");
    vistas.add(k);
    return { inicio, fin };
  });

  // Email opcional (sin él se guarda uno ficticio); entonces el nombre es obligatorio.
  // Los nombres no se repiten (clave sin tildes ni mayúsculas): en el enlace común cada uno elige el suyo.
  if (!Array.isArray(a.invitados) || a.invitados.length < 1 || a.invitados.length > LIMITES.invitados) throw new ErrorEntrada("invitados_invalidos");
  const emails = new Set<string>();
  const nombres = new Set<string>();
  const invitados = a.invitados.map((i) => {
    const x = objeto(i, ["email", "nombre"], "invitados_invalidos");
    let nombre: string | null = null;
    if (x.nombre !== undefined && x.nombre !== null) {
      if (typeof x.nombre !== "string") throw new ErrorEntrada("invitados_invalidos");
      nombre = x.nombre.trim().replace(/\s+/g, " ") || null;
      if (nombre && nombre.length > LIMITES.nombre) throw new ErrorEntrada("invitados_invalidos");
    }
    let email: string;
    if (x.email === undefined || x.email === null || (typeof x.email === "string" && x.email.trim() === "")) {
      if (!nombre) throw new ErrorEntrada("invitados_invalidos");
      email = emailFicticio();
    } else {
      if (typeof x.email !== "string" || x.email.length > 254) throw new ErrorEntrada("invitados_invalidos");
      email = x.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email) || esEmailFicticio(email)) throw new ErrorEntrada("invitados_invalidos");
    }
    if (emails.has(email)) throw new ErrorEntrada("invitados_invalidos");
    emails.add(email);
    if (nombre) {
      const k = claveNombre(nombre);
      if (nombres.has(k)) throw new ErrorEntrada("nombres_repetidos");
      nombres.add(k);
    }
    return { email, nombre };
  });

  return { titulo, descripcion, cierre, opciones, invitados };
}

export type CambiosEncuesta = {
  titulo?: string;
  descripcion?: string | null;
  cierre?: string;
  reabrir?: boolean;
  opciones_nuevas?: { inicio: string; fin: string }[];
  opciones_quitar?: string[];
  invitados_nuevos?: { nombre: string | null; email: string | null }[];
  invitados_editar?: { id: string; nombre?: string | null; email?: string | null }[];
  invitados_quitar?: string[];
};

/** editar_encuesta: valida la forma; las reglas que dependen de lo que ya hay (repetidos, límites) las aplica la BD. */
export function validarEditar(args: unknown, ahoraMs = Date.now()): { id: string; cambios: CambiosEncuesta } {
  const a = objeto(args, ["id", "titulo", "descripcion", "cierre", "reabrir", "opciones_nuevas", "opciones_quitar",
    "invitados_nuevos", "invitados_editar", "invitados_quitar"], "argumentos_invalidos");
  const id = uuid(a.id);
  const c: CambiosEncuesta = {};
  const lista = (v: unknown, max: number, codigo: string): unknown[] => {
    if (!Array.isArray(v) || v.length > max) throw new ErrorEntrada(codigo);
    return v;
  };
  const nombreDe = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new ErrorEntrada("invitados_invalidos");
    const n = v.trim().replace(/\s+/g, " ");
    if (n.length > LIMITES.nombre) throw new ErrorEntrada("invitados_invalidos");
    return n || null;
  };
  const emailDe = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v.length > 254) throw new ErrorEntrada("invitados_invalidos");
    const e = v.trim().toLowerCase();
    if (!e) return null;
    if (!EMAIL_RE.test(e) || esEmailFicticio(e)) throw new ErrorEntrada("invitados_invalidos");
    return e;
  };

  if (a.titulo !== undefined) {
    if (typeof a.titulo !== "string" || !a.titulo.trim() || a.titulo.trim().length > LIMITES.titulo) throw new ErrorEntrada("titulo_invalido");
    c.titulo = a.titulo.trim();
  }
  if (a.descripcion !== undefined) {
    if (a.descripcion !== null && (typeof a.descripcion !== "string" || a.descripcion.trim().length > LIMITES.descripcion)) throw new ErrorEntrada("descripcion_invalida");
    c.descripcion = typeof a.descripcion === "string" ? a.descripcion.trim() || null : null;
  }
  if (a.cierre !== undefined) {
    c.cierre = fecha(a.cierre, "cierre_invalido");
    if (Date.parse(c.cierre) <= ahoraMs) throw new ErrorEntrada("cierre_invalido");
  }
  if (a.reabrir !== undefined) {
    if (typeof a.reabrir !== "boolean") throw new ErrorEntrada("argumentos_invalidos");
    c.reabrir = a.reabrir;
  }
  if (a.opciones_quitar !== undefined) c.opciones_quitar = [...new Set(lista(a.opciones_quitar, LIMITES.opciones, "opcion_invalida").map((x) => uuid(x, "opcion_invalida")))];
  if (a.opciones_nuevas !== undefined) {
    c.opciones_nuevas = lista(a.opciones_nuevas, LIMITES.opciones, "opciones_invalidas").map((o) => {
      const x = objeto(o, ["inicio", "fin"], "opciones_invalidas");
      const inicio = fecha(x.inicio, "opciones_invalidas"), fin = fecha(x.fin, "opciones_invalidas");
      if (Date.parse(fin) <= Date.parse(inicio) || Date.parse(inicio) <= ahoraMs) throw new ErrorEntrada("opciones_invalidas");
      return { inicio, fin };
    });
  }
  if (a.invitados_quitar !== undefined) c.invitados_quitar = [...new Set(lista(a.invitados_quitar, LIMITES.invitados, "invitado_invalido").map((x) => uuid(x, "invitado_invalido")))];
  if (a.invitados_editar !== undefined) {
    const vistos = new Set<string>();
    c.invitados_editar = lista(a.invitados_editar, LIMITES.invitados, "invitados_invalidos").map((i) => {
      const x = objeto(i, ["id", "nombre", "email"], "invitados_invalidos");
      const id2 = uuid(x.id, "invitado_invalido");
      if (vistos.has(id2)) throw new ErrorEntrada("invitados_invalidos");
      vistos.add(id2);
      const out: { id: string; nombre?: string | null; email?: string | null } = { id: id2 };
      if ("nombre" in x) out.nombre = nombreDe(x.nombre);
      if ("email" in x) out.email = emailDe(x.email);
      return out;
    });
  }
  if (a.invitados_nuevos !== undefined) {
    c.invitados_nuevos = lista(a.invitados_nuevos, LIMITES.invitados, "invitados_invalidos").map((i) => {
      const x = objeto(i, ["nombre", "email"], "invitados_invalidos");
      const nombre = nombreDe(x.nombre), email = emailDe(x.email);
      if (!nombre && !email) throw new ErrorEntrada("invitados_invalidos");
      return { nombre, email };
    });
  }
  // Nombres repetidos dentro de lo que llega (la BD comprueba también contra lo que ya hay).
  const nn = [...(c.invitados_nuevos || []).map((i) => i.nombre), ...(c.invitados_editar || []).map((i) => i.nombre)]
    .filter((n): n is string => !!n).map(claveNombre);
  if (new Set(nn).size !== nn.length) throw new ErrorEntrada("nombres_repetidos");
  if (!Object.keys(c).length) throw new ErrorEntrada("sin_cambios");
  return { id, cambios: c };
}

export function validarSinArgumentos(args: unknown): void {
  if (args === undefined || args === null) return;
  objeto(args, [], "argumentos_invalidos");
}

export function validarId(args: unknown): { id: string } {
  const a = objeto(args, ["id"], "argumentos_invalidos");
  return { id: uuid(a.id) };
}

export function validarConvocar(args: unknown): { id: string; opcion_id: string; evento_outlook_id: string | null } {
  const a = objeto(args, ["id", "opcion_id", "evento_outlook_id"], "argumentos_invalidos");
  let evento: string | null = null;
  if (a.evento_outlook_id !== undefined && a.evento_outlook_id !== null) {
    if (typeof a.evento_outlook_id !== "string" || !EVENTO_RE.test(a.evento_outlook_id)) throw new ErrorEntrada("evento_invalido");
    evento = a.evento_outlook_id;
  }
  return { id: uuid(a.id), opcion_id: uuid(a.opcion_id, "opcion_invalida"), evento_outlook_id: evento };
}

export function validarEnviados(args: unknown): { id: string; emails: string[] } {
  const a = objeto(args, ["id", "emails"], "argumentos_invalidos");
  if (!Array.isArray(a.emails) || a.emails.length < 1 || a.emails.length > LIMITES.invitados) throw new ErrorEntrada("emails_invalidos");
  const emails = [...new Set(a.emails.map((e) => {
    if (typeof e !== "string" || e.length > 254) throw new ErrorEntrada("emails_invalidos");
    const x = e.trim().toLowerCase();
    if (!EMAIL_RE.test(x)) throw new ErrorEntrada("emails_invalidos");
    return x;
  }))];
  return { id: uuid(a.id), emails };
}
