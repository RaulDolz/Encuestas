/** Cookie con el token del invitado. Path=/e/<id>: solo viaja a esa encuesta. */
export const COOKIE_TOKEN = "jorcas_t";

/** 120 días: cubre de sobra la vida de una encuesta. */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 120;

export function rutaEncuesta(encuestaId: string): string {
  return `/e/${encuestaId}`;
}

/** Cookie con el código del enlace común (solo si se entró por él): permite «Cambiar de persona». */
export const COOKIE_CODIGO = "jorcas_c";
