import { cookies } from "next/headers";
import { cargarVista, type VistaEncuesta } from "@/lib/encuestas";
import { esToken, esUuid } from "@/lib/validacion";
import { COOKIE_CODIGO, COOKIE_TOKEN, rutaEncuesta } from "@/lib/cookie";
import { codigoComunValido } from "@/lib/comun-codigo";
import { EnlaceNoValido, NoDisponible } from "@/components/Aviso";
import Votacion from "@/components/Votacion";

export default async function PaginaEncuesta({ params }: PageProps<"/e/[id]">) {
  const { id } = await params;
  const jar = await cookies();
  const token = jar.get(COOKIE_TOKEN)?.value;
  const codigo = jar.get(COOKIE_CODIGO)?.value;

  if (!esUuid(id) || !esToken(token)) return <EnlaceNoValido />;

  let vista: VistaEncuesta | null;
  try {
    vista = await cargarVista(id.toLowerCase(), token);
  } catch {
    return <NoDisponible />;
  }
  if (!vista) return <EnlaceNoValido />;

  // Si entró por el enlace común, puede volver a la lista para cambiar de persona.
  const lid = id.toLowerCase();
  const enlaceCambiar = codigoComunValido(lid, codigo) ? `${rutaEncuesta(lid)}?c=${codigo}` : null;

  return <Votacion vista={vista} enlaceCambiar={enlaceCambiar} />;
}
