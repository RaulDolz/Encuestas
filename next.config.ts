import type { NextConfig } from "next";

const cabecerasSeguridad = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
  },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,

  async headers() {
    return [
      // /api/oauth/authorize redirige (tras enviar el formulario) al callback de claude.ai:
      // su CSP necesita form-action con ese origen. El resto de rutas, la CSP general.
      { source: "/((?!api/oauth/authorize$).*)", headers: cabecerasSeguridad },
      {
        source: "/api/oauth/authorize",
        headers: cabecerasSeguridad.map((h) =>
          h.key === "Content-Security-Policy"
            ? { ...h, value: "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self' https://claude.ai" }
            : h,
        ),
      },
      // Administración (OAuth y MCP): nunca en caché.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      // Páginas y API de encuestas: nunca en caché compartida.
      { source: "/e/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },

  async rewrites() {
    return {
      // /e/<id>?t=<token> (enlace del correo) -> Route Handler que fija la cookie
      // y redirige a /e/<id> sin token. Sin ?t= se sirve la página normal.
      beforeFiles: [
        {
          source: "/e/:id",
          has: [{ type: "query", key: "t" }],
          destination: "/e/:id/acceso",
        },
      ],
      // Descubrimiento OAuth (RFC 9728 / RFC 8414) para el conector MCP de claude.ai.
      afterFiles: [
        { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/protected-resource" },
        { source: "/.well-known/oauth-protected-resource/api/mcp", destination: "/api/oauth/protected-resource" },
        { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/authorization-server" },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
