import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Error de configuración del servidor (variables de entorno ausentes o mal formadas). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

let cliente: SupabaseClient | null = null;

/**
 * Cliente de Supabase con la clave de servidor. Solo se importa desde código
 * de servidor ("server-only" rompe el build si alguien lo importa en cliente).
 *
 * Acepta tanto la secret key nueva (sb_secret_...) como la service_role legacy
 * (JWT): supabase-js envía las nuevas solo en la cabecera apikey y las legacy
 * también como Bearer.
 */
export function getSupabase(): SupabaseClient {
  if (cliente) return cliente;

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  const faltan: string[] = [];
  if (!url) faltan.push("SUPABASE_URL");
  if (!key) faltan.push("SUPABASE_SERVICE_ROLE_KEY");
  if (faltan.length > 0) {
    const msg = `[config] Faltan variables de entorno: ${faltan.join(", ")}`;
    console.error(msg);
    throw new ConfigError(msg);
  }

  let parsed: URL;
  try {
    parsed = new URL(url!);
  } catch {
    const msg = "[config] SUPABASE_URL no es una URL válida";
    console.error(msg);
    throw new ConfigError(msg);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    const msg = "[config] SUPABASE_URL debe usar https";
    console.error(msg);
    throw new ConfigError(msg);
  }

  // Con una clave publishable/anon, RLS devuelve 0 filas sin error y todo
  // parecería "Enlace no válido". Mejor fallar con un mensaje claro.
  if (!esClaveDeServidor(key!)) {
    const msg =
      "[config] SUPABASE_SERVICE_ROLE_KEY no es una clave de servidor: usa la secret key (sb_secret_...) o la service_role legacy, no la publishable/anon";
    console.error(msg);
    throw new ConfigError(msg);
  }

  cliente = createClient(url!, key!, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      // Nunca cachear lecturas: los votos cambian continuamente.
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
  return cliente;
}

/** true para sb_secret_... o para un JWT legacy con role = service_role. Nunca registra la clave. */
function esClaveDeServidor(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  if (key.startsWith("sb_")) return false; // sb_publishable_, sb_temp_, etc.
  const partes = key.split(".");
  if (partes.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8")) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}
