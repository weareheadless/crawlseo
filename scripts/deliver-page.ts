/**
 * Host-side delivery entry point for a tenant-owned page generator.
 *
 * The generator owns the copy and the render. CrawlSEO owns the connector:
 * this command writes the component source into the site repository, pushes it,
 * publishes the Wix site and verifies the live pages. It is deliberately a CLI
 * and not a second HTTP surface: the caller runs on the same host as the Wix
 * bridge, and no new credential leaves that host.
 *
 * Usage:
 *   tsx scripts/deliver-page.ts --payload <file> [--dry-run]
 *
 * The payload is JSON:
 * {
 *   "siteId": "...",
 *   "taskId": "agenda-atelier-harmonie",
 *   "message": "CrawlSEO: agenda ... — 2026-11-12",
 *   "seo": { "title": "...", "description": "..." },   // primary page only
 *   "pages": [
 *     { "route": "/page", "htmlFile": "/abs/page.html" },
 *     { "route": "/page", "locale": "en", "htmlFile": "...",
 *       "seo": { "title": "...", "description": "..." } } // injected tags
 *   ]
 * }
 *
 * `pages[0]` is the primary page. Relative `htmlFile` paths are resolved
 * against the payload file's directory. The command prints one JSON object and
 * exits 0 only when every page is live. No page is delivered twice.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { commitAndPushFiles } from "@/lib/agent-tasks/code-sync";
import {
  deliverWixPageComponent,
  publishDeliveredPages,
  type WixPageComponentResult,
  type WixPagePublishResult,
} from "@/lib/delivery/wix-early-packet";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";

type Seo = { title: string; description: string };

type PageInput = {
  route: string;
  locale: string | null;
  alternateRoute: string | null;
  htmlFile: string;
  seo: Seo | null;
};

type Payload = {
  siteId: string;
  taskId: string;
  message: string;
  seo?: Seo | null;
  pages: PageInput[];
  publish?: boolean;
};

type Result = {
  status: "delivered" | "verified" | "pending" | "dry-run" | "failed";
  siteId: string;
  message: string;
  pages: Array<{
    route: string;
    locale: string | null;
    url: string;
    tag: string;
    characters: number;
    sourcePath: string | null;
    packetKey: string;
    placement: string;
  }>;
  codeSync: Awaited<ReturnType<typeof commitAndPushFiles>> | null;
  publish: WixPagePublishResult | null;
  error?: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): { payloadFile: string; dryRun: boolean } {
  let payloadFile = "";
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--payload") {
      payloadFile = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!payloadFile) fail("--payload <file> is required");
  return { payloadFile: path.resolve(payloadFile), dryRun };
}

function assertSeo(value: unknown, label: string): Seo | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!title || !description) fail(`${label} needs a non-empty title and description`);
  return { title, description };
}

function readPayload(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("The payload must be an object");
  const record = value as Record<string, unknown>;
  const siteId = typeof record.siteId === "string" ? record.siteId.trim() : "";
  const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!siteId || !taskId || !message) fail("siteId, taskId and message are required");
  if (!Array.isArray(record.pages) || record.pages.length === 0) fail("pages must be a non-empty array");
  const pages = record.pages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`pages[${index}] must be an object`);
    const page = entry as Record<string, unknown>;
    const route = typeof page.route === "string" ? page.route.trim() : "";
    const htmlFile = typeof page.htmlFile === "string" ? page.htmlFile.trim() : "";
    if (!route || !htmlFile) fail(`pages[${index}] needs route and htmlFile`);
    const locale = typeof page.locale === "string" && page.locale.trim() ? page.locale.trim() : null;
    const alternateRoute =
      typeof page.alternateRoute === "string" && page.alternateRoute.trim() ? page.alternateRoute.trim() : null;
    return {
      route,
      locale,
      alternateRoute,
      htmlFile,
      seo: assertSeo(page.seo, `pages[${index}].seo`),
    };
  });
  if (pages[0].locale) fail("pages[0] must be the primary page (no locale)");
  return {
    siteId,
    taskId,
    message,
    seo: assertSeo(record.seo, "seo"),
    pages,
    publish: record.publish !== false,
  };
}

async function main(): Promise<number> {
  const { payloadFile, dryRun } = parseArgs(process.argv.slice(2));
  const payloadDir = path.dirname(payloadFile);
  const payload = readPayload(JSON.parse(await readFile(payloadFile, "utf8")));
  const html = await Promise.all(
    payload.pages.map((page) =>
      readFile(path.isAbsolute(page.htmlFile) ? page.htmlFile : path.join(payloadDir, page.htmlFile), "utf8"),
    ),
  );
  if (html.some((value) => value.trim().length === 0)) fail("A page has no HTML to deliver");

  const summary: Result = {
    status: dryRun ? "dry-run" : "delivered",
    siteId: payload.siteId,
    message: payload.message,
    pages: payload.pages.map((page, index) => ({
      route: page.route,
      locale: page.locale,
      url: "",
      tag: "",
      characters: html[index].length,
      sourcePath: null,
      packetKey: "",
      placement: "not-checked",
    })),
    codeSync: null,
    publish: null,
  };
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  }

  // Packet scratch files belong in the temp directory, not the immutable
  // release slot. All payload paths are already absolute.
  process.chdir(os.tmpdir());

  const components: WixPageComponentResult[] = [];
  for (const [index, page] of payload.pages.entries()) {
    components.push(
      await deliverWixPageComponent({
        siteId: payload.siteId,
        route: page.route,
        html: html[index],
        taskId: payload.taskId,
        localeCode: page.locale,
        alternateRoute: page.alternateRoute,
        seoHead: page.seo,
      }),
    );
  }

  summary.pages = components.map((component, index) => ({
    route: component.route,
    locale: payload.pages[index].locale,
    url: component.url,
    tag: component.tag,
    characters: html[index].length,
    sourcePath: component.sourcePath,
    packetKey: component.packetKey,
    placement: component.placement,
  }));

  const deliveryConfig = await getSiteDeliveryConfig(payload.siteId);
  const sourcePaths = [...new Set(components.map((component) => component.sourcePath).filter((value): value is string => Boolean(value)))];
  if (sourcePaths.length > 0 && deliveryConfig?.repoPath) {
    summary.codeSync = await commitAndPushFiles(deliveryConfig.repoPath, sourcePaths, payload.message);
  }

  if (!payload.publish) {
    summary.status = "delivered";
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  }
  if (!deliveryConfig?.bridgeAlias) fail("This site has no Wix bridge alias configured");

  const ordered = components
    .map((component, index) => ({ component, page: payload.pages[index] }))
    .sort((left, right) => Number(Boolean(left.page.locale)) - Number(Boolean(right.page.locale)));
  summary.publish = await publishDeliveredPages({
    alias: deliveryConfig.bridgeAlias,
    pages: ordered.map(({ component, page }) => ({
      url: component.url,
      packetKey: component.packetKey,
      injectedSeo: page.seo,
    })),
    seo: payload.seo,
  });
  summary.status = summary.publish.status === "verified" ? "verified" : summary.publish.status === "pending" ? "pending" : "failed";
  if (summary.status === "failed" && summary.publish.error) summary.error = summary.publish.error;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.status === "verified" ? 0 : summary.status === "pending" ? 2 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ status: "failed", error: message })}\n`);
    process.exitCode = 1;
  });
