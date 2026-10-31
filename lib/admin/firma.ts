// Tokens firmados (HMAC-SHA256) sin estado: client_id, códigos de autorización,
// tokens de acceso y de refresco. La clave de firma se deriva de ADMIN_API_KEY:
// rotar ADMIN_API_KEY invalida TODOS los tokens emitidos.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { claveAdmin } from "./config.ts";

export type TipoToken = "cid" | "code" | "at" | "rt";

type Carga = { typ: TipoToken; exp?: number; [k: string]: unknown };

const PREFIJO = "jc1";

function claveFirma(): Buffer | null {
  const k = claveAdmin();
  if (!k) return null;
  return Buffer.from(hkdfSync("sha256", k, "encuestas-jorcas-2027", "oauth-firma-v1", 32));
}

/** Comparación en tiempo constante (también cuando las longitudes difieren). */
export function igualSeguro(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function ahora(): number {
  return Math.floor(Date.now() / 1000);
}

export function firmar(typ: TipoToken, datos: Record<string, unknown>, ttlSegundos?: number): string {
  const clave = claveFirma();
  if (!clave) throw new Error("admin_desactivado");
  const carga: Carga = { ...datos, typ, jti: randomBytes(12).toString("base64url") };
  if (ttlSegundos) carga.exp = ahora() + ttlSegundos;
  const cuerpo = Buffer.from(JSON.stringify(carga), "utf8").toString("base64url");
  const firma = createHmac("sha256", clave).update(`${PREFIJO}.${cuerpo}`).digest("base64url");
  return `${PREFIJO}.${cuerpo}.${firma}`;
}

/** Devuelve la carga si la firma, el tipo y la caducidad son válidos; null en cualquier otro caso. */
export function verificar(token: unknown, typ: TipoToken): Carga | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const clave = claveFirma();
  if (!clave) return null;
  const partes = token.split(".");
  if (partes.length !== 3 || partes[0] !== PREFIJO) return null;
  const esperada = createHmac("sha256", clave).update(`${partes[0]}.${partes[1]}`).digest("base64url");
  if (!igualSeguro(esperada, partes[2])) return null;
  let carga: Carga;
  try {
    carga = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8")) as Carga;
  } catch {
    return null;
  }
  if (!carga || typeof carga !== "object" || carga.typ !== typ) return null;
  if (typeof carga.exp === "number" && carga.exp < ahora()) return null;
  return carga;
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge. */
export function pkceValido(verifier: unknown, challenge: unknown): boolean {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const calculado = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return igualSeguro(calculado, challenge);
}
