const TZ = "Europe/Madrid";

const fmtDiaLargo = new Intl.DateTimeFormat("es-ES", {
  timeZone: TZ,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const fmtHora = new Intl.DateTimeFormat("es-ES", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
});
const fmtDiaCorto = new Intl.DateTimeFormat("es-ES", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
});
const fmtClaveDia = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const mayus = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Sábado, 14 de noviembre de 2026, a las 23:59" */
export function fechaHoraLarga(iso: string): string {
  const d = new Date(iso);
  return `${mayus(fmtDiaLargo.format(d))}, a las ${fmtHora.format(d)}`;
}

/** Texto de una opción: { dia: "Sábado, 14 de noviembre de 2026", horas: "de 18:00 a 20:00" } */
export function textoOpcion(inicioIso: string, finIso: string): { dia: string; horas: string; corto: string } {
  const ini = new Date(inicioIso);
  const fin = new Date(finIso);
  const mismoDia = fmtClaveDia.format(ini) === fmtClaveDia.format(fin);
  const dia = mayus(fmtDiaLargo.format(ini));
  const horas = mismoDia
    ? `de ${fmtHora.format(ini)} a ${fmtHora.format(fin)}`
    : `desde las ${fmtHora.format(ini)} hasta el ${fmtDiaLargo.format(fin)} a las ${fmtHora.format(fin)}`;
  const corto = `${mayus(fmtDiaCorto.format(ini))} · ${fmtHora.format(ini)}`;
  return { dia, horas, corto };
}
