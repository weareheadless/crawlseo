#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ServiceAuthError, authenticateServiceToken } from "@/lib/auth/service-credentials";
import { createProjectMcpServer } from "./project-tools";

const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.MCP_HTTP_PORT ?? 3004);
const maxRequestBytes = Math.max(16_384, Number(process.env.MCP_MAX_REQUEST_BYTES ?? 2 * 1024 * 1024));
const maxResponseBytes = Math.max(16_384, Number(process.env.MCP_MAX_RESPONSE_BYTES ?? 2 * 1024 * 1024));
const allowedHosts = new Set(
  (process.env.MCP_ALLOWED_HOSTS ?? "crawlseo.helloada.app,127.0.0.1,localhost")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const allowedHostHeaders = new Set([
  ...allowedHosts,
  ...[...allowedHosts].map((allowedHost) => `${allowedHost}:${port}`),
]);

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  const encoded = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  res.end(encoded);
}

function requestId(req: IncomingMessage): string {
  return req.headers["x-request-id"]?.toString().slice(0, 120) || randomUUID();
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    const error = new Error("request too large");
    error.name = "RequestTooLargeError";
    throw error;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxRequestBytes) {
      req.destroy();
      const error = new Error("request too large");
      error.name = "RequestTooLargeError";
      throw error;
    }
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function installResponseLimit(res: ServerResponse): void {
  let bytes = 0;
  type LimitedResponse = {
    write: (chunk: unknown, ...args: unknown[]) => boolean;
    end: (chunk?: unknown, ...args: unknown[]) => ServerResponse;
  };
  const response = res as unknown as LimitedResponse;
  const originalWrite = response.write.bind(res) as LimitedResponse["write"];
  const originalEnd = response.end.bind(res) as LimitedResponse["end"];
  const count = (chunk: unknown): boolean => {
    if (chunk === undefined || chunk === null) return true;
    const size = Buffer.isBuffer(chunk)
      ? chunk.length
      : Buffer.byteLength(typeof chunk === "string" ? chunk : String(chunk));
    bytes += size;
    return bytes <= maxResponseBytes;
  };
  response.write = (chunk: unknown, ...args: unknown[]) => {
    if (!count(chunk)) {
      res.destroy(new Error("MCP response too large"));
      return false;
    }
    return originalWrite(chunk, ...args);
  };
  response.end = (chunk?: unknown, ...args: unknown[]) => {
    if (!count(chunk)) {
      res.destroy(new Error("MCP response too large"));
      return res;
    }
    return originalEnd(chunk, ...args);
  };
}

function hostAllowed(req: IncomingMessage): boolean {
  const rawHost = req.headers.host?.split(":")[0]?.toLowerCase();
  return Boolean(rawHost && allowedHosts.has(rawHost));
}

const httpServer = createServer(async (req, res) => {
  const id = requestId(req);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  installResponseLimit(res);

  if (url.pathname === "/healthz") {
    json(res, 200, { status: "ok", service: "crawlseo-mcp" });
    return;
  }
  if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
    json(res, 404, { error: "Not found" });
    return;
  }
  if (!hostAllowed(req)) {
    json(res, 400, { error: "Invalid host" });
    return;
  }
  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    res.setHeader("allow", "GET, POST, DELETE");
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const principal = await authenticateServiceToken(bearer(req));
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    const mcp = createProjectMcpServer(principal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      allowedHosts: [...allowedHostHeaders],
      enableDnsRebindingProtection: true,
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
    await mcp.close().catch(() => undefined);
  } catch (error) {
    const status = error instanceof ServiceAuthError ? error.statusCode : 400;
    const code = error instanceof Error && error.name === "RequestTooLargeError" ? 413 : status;
    console.error(`[CrawlSEO MCP] request_id=${id} status=${code}`);
    json(res, code, { error: code === 413 ? "Request too large" : "Request failed", request_id: id });
  }
});

httpServer.listen(port, host, () => {
  console.error(`[CrawlSEO MCP] Streamable HTTP listening on http://${host}:${port}/mcp`);
});

function shutdown(): void {
  httpServer.close(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
