// Código del enlace común de una encuesta: /e/<id>?c=<código>.
// Sin estado: HMAC-SHA256 del id con una clave derivada (HKDF) de ADMIN_API_KEY.
// Rotar ADMIN_API_KEY cambia el código de todas las encuestas (hay que volver a
// repartir el enlace; el artifact siempre muestra el vigente).
// Sin "server-only" para poder probarlo con node:test; solo lo importa código de servidor.
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { claveAdmin } from "./admin/config.ts";
import { igualSeguro } from "./admin/firma.ts";

/** 22 caracteres base64url = 132 bits. */
const LONGITUD = 22;
export const CODIGO_RE = /^[A-Za-z0-9_-]{22}$/;

function clave(): Buffer | null {
  const k = claveAdmin();
  if (!k) return null;
  return Buffer.from(hkdfSync("sha256", k, "encuestas-jorcas-2027", "enlace-comun-v1", 32));
}

/** Código del enlace común, o null si ADMIN_API_KEY no está configurada. */
export function codigoComun(encuestaId: string): string | null {
  const k = clave();
  if (!k) return null;
  return createHmac("sha256", k).update(`comun:${encuestaId.toLowerCase()}`).digest("base64url").slice(0, LONGITUD);
}

export function codigoComunValido(encuestaId: string, codigo: unknown): codigo is string {
  if (typeof codigo !== "string" || !CODIGO_RE.test(codigo)) return false;
  const esperado = codigoComun(encuestaId);
  return esperado !== null && igualSeguro(esperado, codigo);
}

export function enlaceComun(base: string, encuestaId: string): string | null {
  const c = codigoComun(encuestaId);
  return c ? `${base}/e/${encuestaId.toLowerCase()}?c=${c}` : null;
}

/** Email de relleno para quien no tiene (la columna es NOT NULL). */
export const EMAIL_FICTICIO_RE = /^sin-email-[0-9a-f]{16}@jorcas\.invalid$/;

export function emailFicticio(): string {
  return `sin-email-${randomBytes(8).toString("hex")}@jorcas.invalid`;
}

export function esEmailFicticio(email: string | null | undefined): boolean {
  return typeof email === "string" && EMAIL_FICTICIO_RE.test(email);
}

/** Misma clave que public.clave_nombre (0005): sin espacios sobrantes, minúsculas, sin tildes, conserva la ñ. */
export function claveNombre(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[áàâä]/g, "a")
    .replace(/[éèêë]/g, "e")
    .replace(/[íìîï]/g, "i")
    .replace(/[óòôö]/g, "o")
    .replace(/[úùûü]/g, "u");
}
