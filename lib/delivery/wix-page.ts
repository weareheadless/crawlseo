import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import {
  assertNegotiatedWixBridgeOperations,
  createBridgeSnippet,
  listBridgeSnippets,
  readBridgeEmbed,
  writeBridgeEmbed,
} from "@/lib/bridge/client";
import { chromeExecutable } from "@/lib/agent-tasks/screenshots";

const execFileAsync = promisify(execFile);
const MANAGED_PREFIX = "CrawlSEO ";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class WixPageDeliveryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "WixPageDeliveryError";
  }
}

export type WixPageDeliveryResult = {
  targetKey: string;
  snippetId: string;
  name: string;
  created: boolean;
  url: string;
  htmlSha256: string;
  readback: "match" | "mismatch";
  live: {
    httpStatus: number | null;
    marker: "found" | "missing" | "unavailable";
  };
};

function routePath(route: string): string {
  const trimmed = route.trim();
  if (!trimmed.startsWith("/") || trimmed === "/" || /[?#\s]/.test(trimmed) || trimmed.includes("//") || trimmed.split("/").includes("..")) {
    throw new WixPageDeliveryError("A page route must be one exact non-root path, such as /playa-del-carmen-condos", 400);
  }
  return trimmed.replace(/\/+$/, "");
}

function siteUrl(domain: string, route: string): string {
  const host = domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return `https://${host}${route}`;
}

function embedName(route: string): string {
  const base = `${MANAGED_PREFIX}${route}`;
  if (base.length <= 100) return base;
  // Keep the name stable and unique when a long route would be truncated.
  return `${base.slice(0, 92)}#${sha256(route).slice(0, 6)}`;
}

/** A page route is live when the host answers it without a redirect to an error page. */
export async function probeWixRoute(url: string, timeoutMs = 20_000): Promise<number | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "CrawlSEO delivery probe" },
    });
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Render the page with a browser so the injected embed has run. A plain fetch
 * returns Wix's shell, not the mounted content. When no browser is available
 * the result is `null`, which the caller reports as unverified rather than
 * pretending it checked.
 */
export async function renderPageDom(url: string, timeoutMs = 90_000): Promise<string | null> {
  const chrome = await chromeExecutable();
  if (!chrome) return null;
  try {
    const { stdout } = await execFileAsync(chrome, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--virtual-time-budget=20000",
      "--disable-blink-features=AutomationControlled",
      "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "--dump-dom",
      url,
    ], { timeout: timeoutMs, maxBuffer: 24 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

type WixPageTarget = {
  siteId: string;
  alias: string;
  domain: string;
  route: string;
  url: string;
  name: string;
};

async function resolveWixPageTarget(siteId: string, route: string): Promise<WixPageTarget> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, domain: true, retiredAt: true },
  });
  if (!site || site.retiredAt) throw new WixPageDeliveryError("Site not found or retired", 404);
  const config = await getSiteDeliveryConfig(siteId);
  if (!config || !config.enabled) {
    throw new WixPageDeliveryError("Wix delivery is not enabled for this site", 409);
  }
  const adapters = Array.isArray(config.adapters) ? config.adapters : [];
  if (adapters.length > 0 && !adapters.includes("wix_embed")) {
    throw new WixPageDeliveryError("This site's delivery config does not include the Wix embed adapter", 409);
  }
  const alias = config.bridgeAlias.trim();
  if (!alias) throw new WixPageDeliveryError("The site has no Wix bridge alias", 409);
  const normalizedRoute = routePath(route);
  return {
    siteId: site.id,
    alias,
    domain: site.domain,
    route: normalizedRoute,
    url: siteUrl(site.domain, normalizedRoute),
    name: embedName(normalizedRoute),
  };
}

async function writeHtmlFile(html: string): Promise<string> {
  const dir = path.join("/tmp/opencode", "wix-page");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.html`);
  await writeFile(file, html, "utf8");
  return file;
}

async function adoptOrCreateEmbed(
  target: WixPageTarget,
  htmlFile: string,
): Promise<{ snippetId: string; created: boolean; storedHtmlSha256: string | null }> {
  const listed = await listBridgeSnippets(target.alias) as { snippets?: Array<{ id?: string; name?: string }> };
  const existing = (listed.snippets ?? []).find((snippet) => snippet.name === target.name && snippet.id);
  if (existing?.id) return { snippetId: existing.id, created: false, storedHtmlSha256: null };

  const receipt = await createBridgeSnippet(target.alias, {
    name: target.name,
    htmlFile,
    route: target.route,
    apply: true,
  }) as { customEmbedId?: string; htmlSha256?: string };
  if (!receipt.customEmbedId) {
    throw new WixPageDeliveryError("The Wix bridge created no custom embed id", 502);
  }
  return {
    snippetId: receipt.customEmbedId,
    created: true,
    storedHtmlSha256: typeof receipt.htmlSha256 === "string" ? receipt.htmlSha256 : null,
  };
}

/**
 * Deliver one page as a route-guarded Custom Embed.
 *
 * The embed owns the page's content container, so the HTML must be a fragment
 * with its own scoped styles. The Wix page itself is created by a human: Wix
 * has no API for site pages. This function creates the embed when the route
 * has none and writes into it on later deliveries.
 */
export async function deliverWixPageHtml(input: {
  siteId: string;
  route: string;
  html: string;
  marker: string;
  taskId?: string;
}): Promise<WixPageDeliveryResult> {
  if (!input.html.trim()) throw new WixPageDeliveryError("The page HTML is empty", 400);
  if (!input.marker.trim()) throw new WixPageDeliveryError("A live marker is required to verify the page", 400);

  const target = await resolveWixPageTarget(input.siteId, input.route);
  await assertNegotiatedWixBridgeOperations(target.alias, ["read_embed", "write_embed"]);

  const existingTarget = await db.deliveryTarget.findUnique({
    where: { siteId_key: { siteId: target.siteId, key: `page:${target.route}` } },
  });

  const htmlFile = await writeHtmlFile(input.html);
  let snippetId = existingTarget?.snippetId ?? null;
  let created = false;
  let storedSha: string | null = null;

  if (!snippetId) {
    const adopted = await adoptOrCreateEmbed(target, htmlFile);
    snippetId = adopted.snippetId;
    created = adopted.created;
    storedSha = adopted.storedHtmlSha256;
  }
  if (!created) {
    // An adopted or existing embed is always rewritten so its content is the
    // reviewed page, and the write keeps the route guard.
    const receipt = await writeBridgeEmbed(target.alias, snippetId, htmlFile, target.route, true) as {
      htmlSha256?: string;
    };
    storedSha = typeof receipt.htmlSha256 === "string" ? receipt.htmlSha256 : null;
  }

  const readback = await readBridgeEmbed(target.alias, snippetId) as {
    embed?: { htmlSha256?: string };
  };
  const readbackMatches = Boolean(storedSha) && readback.embed?.htmlSha256 === storedSha;

  await db.deliveryTarget.upsert({
    where: { siteId_key: { siteId: target.siteId, key: `page:${target.route}` } },
    create: {
      siteId: target.siteId,
      key: `page:${target.route}`,
      kind: "page",
      adapter: "wix_embed",
      snippetId,
      route: target.route,
      metadata: { mode: "page", marker: input.marker, name: target.name, taskId: input.taskId ?? null } as never,
    },
    update: {
      snippetId,
      route: target.route,
      enabled: true,
      metadata: { mode: "page", marker: input.marker, name: target.name, taskId: input.taskId ?? null } as never,
    },
  });

  const httpStatus = await probeWixRoute(target.url);
  let marker: WixPageDeliveryResult["live"]["marker"] = "unavailable";
  if (httpStatus === 200) {
    const dom = await renderPageDom(target.url);
    if (dom) marker = dom.includes(input.marker) ? "found" : "missing";
  }

  return {
    targetKey: `page:${target.route}`,
    snippetId,
    name: target.name,
    created,
    url: target.url,
    htmlSha256: storedSha ?? sha256(input.html),
    readback: readbackMatches ? "match" : "mismatch",
    live: { httpStatus, marker },
  };
}

/** Read the delivered HTML for a target, for a task's review or a re-delivery. */
export async function readDeliveredWixPageHtml(siteId: string, targetKey: string): Promise<{ snippetId: string; html: string } | null> {
  const target = await db.deliveryTarget.findUnique({
    where: { siteId_key: { siteId, key: targetKey } },
    select: { snippetId: true },
  });
  if (!target?.snippetId) return null;
  const config = await getSiteDeliveryConfig(siteId);
  if (!config?.bridgeAlias) return null;
  const readback = await readBridgeEmbed(config.bridgeAlias, target.snippetId) as {
    embed?: { html?: string };
  };
  if (typeof readback.embed?.html !== "string") return null;
  return { snippetId: target.snippetId, html: readback.embed.html };
}

export function readPageHtmlFile(file: string): Promise<string> {
  return readFile(file, "utf8");
}
