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
      { source: "/:path*", headers: cabecerasSeguridad },
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
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
