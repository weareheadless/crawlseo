import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone is for Docker; Vercel uses its own output
  output: process.env.VERCEL ? undefined : "standalone",
  basePath: "/crawlseo",
  // Allow HMR WebSocket connections through the reverse proxy
  allowedDevOrigins: ["crawlseo.helloada.app"],
};

export default nextConfig;
