import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone is for Docker; Vercel uses its own output
  output: process.env.VERCEL ? undefined : "standalone",
  basePath: "/crawlseo",
  // Allow HMR WebSocket connections through the reverse proxy
  allowedDevOrigins: ["crawlseo.helloada.app"],
  /**
   * The legacy screens were removed, not hidden. These redirects keep every
   * bookmark, connector link and old release reference working while the files
   * are gone.
   */
  async redirects() {
    return [
      { source: "/sites/:siteId/content-studio/:path*", destination: "/sites/:siteId/work", permanent: false },
      { source: "/sites/:siteId/legacy-work/:path*", destination: "/sites/:siteId/work", permanent: false },
      { source: "/sites/:siteId/legacy-opportunities/:path*", destination: "/sites/:siteId/opportunities", permanent: false },
      { source: "/sites/:siteId/actions/:path*", destination: "/sites/:siteId/work", permanent: false },
      { source: "/sites/:siteId/findings/:path*", destination: "/sites/:siteId/opportunities", permanent: false },
      { source: "/sites/:siteId/results/:path*", destination: "/sites/:siteId/work", permanent: false },
      { source: "/sites/:siteId/research/config", destination: "/sites/:siteId/evidence/config", permanent: false },
      { source: "/sites/:siteId/research/:path*", destination: "/sites/:siteId/evidence", permanent: false },
      { source: "/sites/:siteId/intelligence/:path*", destination: "/sites/:siteId/opportunities", permanent: false },
    ];
  },
};

export default nextConfig;
