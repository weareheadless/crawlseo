import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOOL_NAME = "seo_get_dataforseo_keyword_report";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function serviceToken(): Promise<string> {
  const inline = process.env.CRAWLSEO_SERVICE_TOKEN?.trim();
  if (inline) return inline;

  const tokenPath = process.env.CRAWLSEO_SERVICE_TOKEN_FILE?.trim();
  if (!tokenPath) {
    throw new Error("Set CRAWLSEO_SERVICE_TOKEN or CRAWLSEO_SERVICE_TOKEN_FILE");
  }

  const contents = await readFile(tokenPath, "utf8");
  const match = /^(?:export\s+)?CRAWLSEO_SERVICE_TOKEN=(.*)$/m.exec(contents);
  const token = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!token) throw new Error(`No CRAWLSEO_SERVICE_TOKEN found in ${tokenPath}`);
  return token;
}

function validateReport(value: unknown): { domain: string; seed: string; report: JsonObject } {
  if (!isObject(value)) throw new Error("MCP returned no structured report");
  if (value.source !== "dataforseo" || !["cached", "unavailable"].includes(String(value.connection))) {
    throw new Error("MCP did not return the persisted DataForSEO surface");
  }
  if (typeof value.domain !== "string" || typeof value.seed !== "string" || !isObject(value.report)) {
    throw new Error("MCP returned an invalid DataForSEO report shape");
  }
  if (
    typeof value.report.keyword_count !== "number" ||
    !Number.isInteger(value.report.keyword_count) ||
    value.report.keyword_count < 0 ||
    !Array.isArray(value.report.keywords)
  ) {
    throw new Error("MCP returned an invalid keyword report shape");
  }
  return { domain: value.domain, seed: value.seed, report: value.report };
}

async function main(): Promise<void> {
  const token = await serviceToken();
  const endpoint = process.env.CRAWLSEO_MCP_URL?.trim() || "http://127.0.0.1:3006/mcp";
  const seed = process.env.CRAWLSEO_DATAFORSEO_SEED?.trim() || "seo";
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Request-ID": `dataforseo-smoke-${randomUUID()}`,
      },
    },
  });
  const client = new Client({ name: "crawlseo-dataforseo-smoke-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === TOOL_NAME)) {
      throw new Error(`MCP tool ${TOOL_NAME} is not registered`);
    }

    const result = await client.callTool({ name: TOOL_NAME, arguments: { seed } });
    if (result.isError) throw new Error("MCP DataForSEO report tool returned an error");
    if (!("structuredContent" in result)) {
      throw new Error("MCP DataForSEO report tool returned no structured content");
    }

    const validated = validateReport(result.structuredContent);
    console.log(JSON.stringify({
      ok: true,
      endpoint,
      tool: TOOL_NAME,
      domain: validated.domain,
      seed: validated.seed,
      keyword_count: validated.report.keyword_count,
      sample: (validated.report.keywords as unknown[]).slice(0, 3),
    }, null, 2));
  } finally {
    await transport.close();
  }
}

main().catch((error: unknown) => {
  const token = process.env.CRAWLSEO_SERVICE_TOKEN?.trim();
  const message = error instanceof Error ? error.message : "DataForSEO MCP smoke test failed";
  console.error(token ? message.replaceAll(token, "[REDACTED]") : message);
  process.exitCode = 1;
});
