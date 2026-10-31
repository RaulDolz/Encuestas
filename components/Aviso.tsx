/** Página informativa mínima (enlace no válido, servicio no disponible, etc.). */
export function Aviso({ titulo, texto }: { titulo: string; texto?: string }) {
  return (
    <main className="contenedor aviso">
      <p className="marca">Comisión de Fiestas de Jorcas 2027</p>
      <h1>{titulo}</h1>
      {texto ? <p className="tenue">{texto}</p> : null}
    </main>
  );
}

export const EnlaceNoValido = () => (
  <Aviso titulo="Enlace no válido" texto="Usa el enlace personal que recibiste por correo." />
);

export const NoDisponible = () => (
  <Aviso titulo="No disponible" texto="Ahora mismo no podemos mostrar la votación. Inténtalo más tarde." />
);
