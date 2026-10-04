module.exports = {
  apps: [
    {
      name: "crawlseo-web",
      cwd: "/SEO",
      script: "scripts/start-production.sh",
      interpreter: "/bin/bash",
      env: { NODE_ENV: "production", PORT: "3001" },
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: "crawlseo-mcp",
      cwd: "/SEO",
      script: "scripts/start-mcp-production.sh",
      interpreter: "/bin/bash",
      env: { NODE_ENV: "production", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "3006" },
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: "crawlseo-worker",
      cwd: "/SEO",
      script: "scripts/start-worker-production.sh",
      interpreter: "/bin/bash",
      env: { NODE_ENV: "production" },
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
  ],
};
