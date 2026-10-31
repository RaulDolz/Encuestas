import { cookies } from "next/headers";
import { cargarVista, type VistaEncuesta } from "@/lib/encuestas";
import { esToken, esUuid } from "@/lib/validacion";
import { COOKIE_TOKEN } from "@/lib/cookie";
import { EnlaceNoValido, NoDisponible } from "@/components/Aviso";
import Votacion from "@/components/Votacion";

export default async function PaginaEncuesta({ params }: PageProps<"/e/[id]">) {
  const { id } = await params;
  const token = (await cookies()).get(COOKIE_TOKEN)?.value;

  if (!esUuid(id) || !esToken(token)) return <EnlaceNoValido />;

  let vista: VistaEncuesta | null;
  try {
    vista = await cargarVista(id.toLowerCase(), token);
  } catch {
    return <NoDisponible />;
  }
  if (!vista) return <EnlaceNoValido />;

  return <Votacion vista={vista} />;
}
