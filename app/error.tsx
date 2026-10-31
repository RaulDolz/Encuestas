"use client";

import { NoDisponible } from "@/components/Aviso";

// No se muestra el error al usuario; el detalle queda en los logs del servidor.
export default function Error() {
  return <NoDisponible />;
}
