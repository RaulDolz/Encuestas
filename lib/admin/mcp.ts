// Servidor MCP mínimo sobre HTTP (Streamable HTTP, sin estado, respuestas JSON).
// Métodos: initialize, notifications/*, ping, tools/list, tools/call.
// Sin sesiones ni SSE: GET y DELETE responden 405.
import { exigirBearer } from "./oauth.ts";
import { baseUrl } from "./config.ts";
import { calcularDetalle, enlaceVoto, resumenLista } from "./calculo.ts";
import type { FilaEncuesta, FilaInvitado, FilaOpcion, FilaVoto } from "./calculo.ts";
import {
  ErrorEntrada,
  LIMITES,
  validarConvocar,
  validarCrear,
  validarEnviados,
  validarId,
  validarSinArgumentos,
} from "./validar.ts";
import type { NuevaEncuesta } from "./validar.ts";
import { enlaceComun, esEmailFicticio } from "../comun-codigo.ts";

/** Acceso a datos (Supabase en producción, falso en los tests). Lanza ErrorDatos con el código. */
export type Datos = {
  crear(e: NuevaEncuesta): Promise<{ id: string; invitados: { nombre: string | null; email: string; token: string }[] }>;
  listar(): Promise<{
    encuestas: Pick<FilaEncuesta, "id" | "titulo" | "estado" | "cierre" | "creada_at">[];
    invitados: { encuesta_id: string; respondio_at: string | null }[];
  }>;
  detalle(id: string): Promise<{ encuesta: FilaEncuesta; opciones: FilaOpcion[]; invitados: FilaInvitado[]; votos: FilaVoto[] } | null>;
  cerrar(id: string): Promise<string>;
  convocar(id: string, opcionId: string, evento: string | null): Promise<void>;
  marcarEnviados(id: string, emails: string[]): Promise<string[]>;
};

export class ErrorDatos extends Error {
  readonly codigo: string;
  constructor(codigo: string) {
    super(codigo);
    this.codigo = codigo;
    this.name = "ErrorDatos";
  }
}

/** Códigos que la BD devuelve como P0001 y que el cliente puede mostrar tal cual. */
export const CODIGOS_NEGOCIO = new Set([
  "titulo_invalido", "descripcion_invalida", "cierre_invalido", "opciones_invalidas", "invitados_invalidos",
  "encuesta_no_encontrada", "opcion_invalida", "encuesta_abierta", "evento_invalido",
]);

export const VERSIONES = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const MAX_CUERPO = 256 * 1024;
const SIN_CACHE = { "Cache-Control": "no-store" };

const ISO = { type: "string", description: "Fecha y hora ISO 8601 con offset, p. ej. 2026-11-26T22:00:00+01:00" };
const UUID = { type: "string", format: "uuid" };

export const HERRAMIENTAS = [
  {
    name: "crear_encuesta",
    title: "Crear encuesta de fecha",
    description:
      "Crea una encuesta con sus opciones (franjas de fecha y hora) e invitados en una sola transacción. Cada invitado necesita nombre o email (los nombres no se repiten). Devuelve el id, el enlace común (enlace_comun: uno para todos, cada uno elige su nombre o se añade) y, por invitado, su enlace personal.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["titulo", "cierre", "opciones", "invitados"],
      properties: {
        titulo: { type: "string", minLength: 1, maxLength: LIMITES.titulo },
        descripcion: { type: ["string", "null"], maxLength: LIMITES.descripcion },
        cierre: ISO,
        opciones: {
          type: "array", minItems: 1, maxItems: LIMITES.opciones,
          items: { type: "object", additionalProperties: false, required: ["inicio", "fin"], properties: { inicio: ISO, fin: ISO } },
        },
        invitados: {
          type: "array", minItems: 1, maxItems: LIMITES.invitados,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              email: { type: ["string", "null"], maxLength: 254, description: "Opcional si hay nombre" },
              nombre: { type: ["string", "null"], maxLength: LIMITES.nombre, description: "Obligatorio si no hay email" },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "listar_encuestas",
    title: "Listar encuestas",
    description: "Lista las encuestas (más recientes primero) con estado, cierre, número de invitados y de respondidos.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "detalle_encuesta",
    title: "Detalle de una encuesta",
    description:
      "Opciones con número de disponibles, matriz invitado × opción, respondidos y pendientes, opción u opciones con más disponibles (empate marcado), enlace común y enlace de cada invitado (email null si no tiene).",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: UUID } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "cerrar_encuesta",
    title: "Cerrar votación",
    description: "Pasa la encuesta de 'abierta' a 'cerrada'. Si ya estaba cerrada o convocada no cambia nada.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: UUID } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "convocar_encuesta",
    title: "Marcar como convocada",
    description:
      "Marca la encuesta como 'convocada' con la opción ganadora (debe ser de esa encuesta y la encuesta debe estar cerrada) y, opcionalmente, el id del evento de Outlook.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id", "opcion_id"],
      properties: { id: UUID, opcion_id: UUID, evento_outlook_id: { type: ["string", "null"], maxLength: 512 } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "marcar_enviados",
    title: "Marcar enlaces enviados",
    description: "Marca la fecha de envío (enviado_at) de los invitados indicados por email.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id", "emails"],
      properties: { id: UUID, emails: { type: "array", minItems: 1, maxItems: LIMITES.invitados, items: { type: "string", maxLength: 254 } } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

async function ejecutar(nombre: string, args: unknown, datos: Datos): Promise<unknown> {
  const base = baseUrl();
  switch (nombre) {
    case "crear_encuesta": {
      const e = validarCrear(args);
      const r = await datos.crear(e);
      return {
        id: r.id,
        enlace_comun: enlaceComun(base, r.id),
        invitados: r.invitados.map((i) => ({
          nombre: i.nombre,
          email: esEmailFicticio(i.email) ? null : i.email,
          enlace: enlaceVoto(base, r.id, i.token),
        })),
      };
    }
    case "listar_encuestas": {
      validarSinArgumentos(args);
      const r = await datos.listar();
      return { encuestas: resumenLista(r.encuestas, r.invitados) };
    }
    case "detalle_encuesta": {
      const { id } = validarId(args);
      const r = await datos.detalle(id);
      if (!r) throw new ErrorDatos("encuesta_no_encontrada");
      return calcularDetalle(r.encuesta, r.opciones, r.invitados, r.votos, base);
    }
    case "cerrar_encuesta": {
      const { id } = validarId(args);
      return { id, estado: await datos.cerrar(id) };
    }
    case "convocar_encuesta": {
      const a = validarConvocar(args);
      await datos.convocar(a.id, a.opcion_id, a.evento_outlook_id);
      return { id: a.id, estado: "convocada", ganadora_opcion_id: a.opcion_id, evento_outlook_id: a.evento_outlook_id };
    }
    case "marcar_enviados": {
      const a = validarEnviados(args);
      const marcados = await datos.marcarEnviados(a.id, a.emails);
      return { id: a.id, marcados, no_encontrados: a.emails.filter((e) => !marcados.includes(e)) };
    }
    default:
      throw new ErrorRpc(-32602, "Herramienta desconocida");
  }
}

class ErrorRpc extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown };

function respuesta(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { "Content-Type": "application/json" }), ...SIN_CACHE, ...extra },
  });
}

const errorRpc = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function manejarMcp(req: Request, datos: Datos): Promise<Response> {
  const auth = exigirBearer(req);
  if (auth) return auth;

  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !(VERSIONES as readonly string[]).includes(pv)) return respuesta(400, errorRpc(null, -32600, "Versión de protocolo no soportada"));

  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) return respuesta(415, errorRpc(null, -32700, "Content-Type debe ser application/json"));
  if (Number(req.headers.get("content-length") ?? "0") > MAX_CUERPO) return respuesta(413, errorRpc(null, -32600, "Petición demasiado grande"));

  let msg: unknown;
  try {
    const t = await req.text();
    if (t.length > MAX_CUERPO) return respuesta(413, errorRpc(null, -32600, "Petición demasiado grande"));
    msg = JSON.parse(t);
  } catch {
    return respuesta(400, errorRpc(null, -32700, "JSON no válido"));
  }
  if (Array.isArray(msg)) return respuesta(400, errorRpc(null, -32600, "Lotes no soportados"));
  if (!msg || typeof msg !== "object") return respuesta(400, errorRpc(null, -32600, "Petición no válida"));
  const m = msg as Rpc;
  if (m.jsonrpc !== "2.0") return respuesta(400, errorRpc(null, -32600, "Petición no válida"));

  // Respuestas del cliente a algo nuestro (no enviamos peticiones): se aceptan y se ignoran.
  if (typeof m.method !== "string") return respuesta(202, null);
  const id = m.id;
  const esNotificacion = id === undefined;
  if (!esNotificacion && typeof id !== "string" && typeof id !== "number") {
    return respuesta(400, errorRpc(null, -32600, "id no válido"));
  }
  if (esNotificacion) return respuesta(202, null);

  const ok = (result: unknown) => respuesta(200, { jsonrpc: "2.0", id, result });

  switch (m.method) {
    case "initialize": {
      const p = (m.params ?? {}) as { protocolVersion?: unknown };
      const pedida = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      const version = (VERSIONES as readonly string[]).includes(pedida) ? pedida : VERSIONES[0];
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "encuestas-jorcas-2027", title: "Encuestas de fecha · Jorcas 2027", version: "1.1.0" },
        instructions:
          "Administración de las encuestas de fecha de la Comisión de Fiestas de Jorcas 2027. Las fechas van en ISO 8601 con offset (hora de Madrid).",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: HERRAMIENTAS });
    case "tools/call": {
      const p = m.params as { name?: unknown; arguments?: unknown } | undefined;
      if (!p || typeof p !== "object" || typeof p.name !== "string") return respuesta(200, errorRpc(id, -32602, "Parámetros no válidos"));
      try {
        const datosRes = await ejecutar(p.name, p.arguments ?? {}, datos);
        return ok({ content: [{ type: "text", text: JSON.stringify(datosRes) }], structuredContent: datosRes, isError: false });
      } catch (e) {
        if (e instanceof ErrorRpc) return respuesta(200, errorRpc(id, e.code, e.message));
        const codigo =
          e instanceof ErrorEntrada || (e instanceof ErrorDatos && CODIGOS_NEGOCIO.has(e.codigo))
            ? (e as ErrorEntrada | ErrorDatos).codigo
            : null;
        if (!codigo) console.error("[mcp] error interno", { herramienta: p.name, tipo: (e as Error)?.name });
        const cuerpo = { error: codigo ?? "error_interno" };
        return ok({ content: [{ type: "text", text: JSON.stringify(cuerpo) }], structuredContent: cuerpo, isError: true });
      }
    }
    default:
      return respuesta(200, errorRpc(id, -32601, "Método no encontrado"));
  }
}
