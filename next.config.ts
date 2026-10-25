import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
];

const nextConfig: NextConfig = {
  output: "standalone", // schlankes Docker-Image ohne node_modules
  poweredByHeader: false,
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Markdown-Material für die Lernseite (max. 2 MB pro Datei, mehrere auf einmal)
    serverActions: { bodySizeLimit: "10mb" },
    // EPUB-Upload (max. 50 MB) geht als Body durch proxy.ts, das ihn sonst bei 10 MB abschneidet
    proxyClientMaxBodySize: "60mb",
  },
  async headers() {
    return [
      // Buchdateien laufen im Lese-iframe (gleiche Herkunft) und setzen ihre eigenen Header (CSP ohne Scripts, SAMEORIGIN)
      { source: "/((?!api/books/[^/]+/file/).*)", headers: securityHeaders },
      { source: "/api/books/:id/file/:path*", headers: securityHeaders.filter((h) => h.key !== "X-Frame-Options") },
      // Service Worker nie zwischenspeichern, damit Updates sofort greifen
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
