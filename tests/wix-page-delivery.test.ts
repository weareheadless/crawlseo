/* eslint-disable @typescript-eslint/no-explicit-any -- a fake Prisma and bridge keep this contract test focused. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state: any = {
    site: { id: "site-1", domain: "example.com", retiredAt: null },
    config: { enabled: true, bridgeAlias: "example", adapters: ["wix_embed"] },
    target: null,
    snippets: [] as Array<{ id: string; name: string }>,
    html: new Map<string, string>(),
    upserts: [] as any[],
    created: [] as any[],
    written: [] as any[],
    chrome: null as string | null,
  };
  const db: any = {
    site: { findUnique: vi.fn(async () => state.site) },
    deliveryTarget: {
      findUnique: vi.fn(async () => state.target),
      upsert: vi.fn(async ({ create, update }: any) => {
        state.upserts.push({ create, update });
        state.target = { ...(state.target ?? {}), ...create, ...update };
        return state.target;
      }),
    },
  };
  return { state, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/site-delivery/config", () => ({
  getSiteDeliveryConfig: vi.fn(async () => h.state.config),
}));
vi.mock("@/lib/agent-tasks/screenshots", () => ({
  chromeExecutable: vi.fn(async () => h.state.chrome),
}));
vi.mock("@/lib/bridge/client", () => ({
  assertNegotiatedWixBridgeOperations: vi.fn(async () => undefined),
  listBridgeSnippets: vi.fn(async () => ({ snippets: h.state.snippets })),
  createBridgeSnippet: vi.fn(async (_alias: string, input: any) => {
    const html = await readFile(input.htmlFile, "utf8");
    const id = "embed-new";
    const wrapped = `guard:${input.route}:${html}`;
    h.state.html.set(id, wrapped);
    h.state.created.push({ ...input, html });
    return { customEmbedId: id, htmlSha256: createHash("sha256").update(wrapped).digest("hex") };
  }),
  writeBridgeEmbed: vi.fn(async (_alias: string, snippetId: string, file: string, route: string) => {
    const html = await readFile(file, "utf8");
    const wrapped = `guard:${route}:${html}`;
    h.state.html.set(snippetId, wrapped);
    h.state.written.push({ snippetId, html, route });
    return { status: "updated", htmlSha256: createHash("sha256").update(wrapped).digest("hex") };
  }),
  readBridgeEmbed: vi.fn(async (_alias: string, snippetId: string) => ({
    embed: {
      htmlSha256: createHash("sha256").update(h.state.html.get(snippetId) ?? "").digest("hex"),
    },
  })),
}));

import { deliverWixPageHtml, probeWixRoute } from "@/lib/delivery/wix-page";

const marker = 'data-crawlseo-task="task-1"';
const html = `<section ${marker}><style>[${marker}] h1{color:red}</style><h1>Condos</h1></section>`;

beforeEach(() => {
  h.state.site = { id: "site-1", domain: "example.com", retiredAt: null };
  h.state.config = { enabled: true, bridgeAlias: "example", adapters: ["wix_embed"] };
  h.state.target = null;
  h.state.snippets = [];
  h.state.html.clear();
  h.state.upserts = [];
  h.state.created = [];
  h.state.written = [];
  h.state.chrome = null;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("generic Wix page delivery", () => {
  it("creates a managed embed when the route has no target", async () => {
    const result = await deliverWixPageHtml({ siteId: "site-1", route: "/condos", html, marker, taskId: "task-1" });

    expect(result.created).toBe(true);
    expect(result.snippetId).toBe("embed-new");
    expect(result.readback).toBe("match");
    expect(result.live.httpStatus).toBe(200);
    expect(result.live.marker).toBe("unavailable");
    expect(h.state.created[0].name).toBe("CrawlSEO /condos");
    expect(h.state.created[0].route).toBe("/condos");
    expect(h.state.upserts[0].create.snippetId).toBe("embed-new");
    expect(h.state.upserts[0].create.route).toBe("/condos");
  });

  it("adopts an embed that already carries the managed name", async () => {
    h.state.snippets = [{ id: "embed-existing", name: "CrawlSEO /condos" }];
    const result = await deliverWixPageHtml({ siteId: "site-1", route: "/condos", html, marker });
    expect(result.created).toBe(false);
    expect(result.snippetId).toBe("embed-existing");
    expect(h.state.created).toHaveLength(0);
  });

  it("writes into the target's embed on a later delivery", async () => {
    h.state.target = { siteId: "site-1", key: "page:/condos", snippetId: "embed-existing", route: "/condos" };
    const result = await deliverWixPageHtml({ siteId: "site-1", route: "/condos", html, marker });
    expect(result.snippetId).toBe("embed-existing");
    expect(h.state.written[0].snippetId).toBe("embed-existing");
    expect(h.state.written[0].html).toBe(html);
    expect(h.state.written[0].route).toBe("/condos");
  });

  it("rejects a root or malformed route", async () => {
    await expect(deliverWixPageHtml({ siteId: "site-1", route: "/", html, marker }))
      .rejects.toThrow(/non-root path/);
    await expect(deliverWixPageHtml({ siteId: "site-1", route: "/a//b", html, marker }))
      .rejects.toThrow(/non-root path/);
  });

  it("refuses to deliver when the site has no enabled Wix delivery", async () => {
    h.state.config = { enabled: false, bridgeAlias: "example", adapters: [] };
    await expect(deliverWixPageHtml({ siteId: "site-1", route: "/condos", html, marker }))
      .rejects.toThrow(/not enabled/);
  });
});

describe("route probe", () => {
  it("returns the HTTP status", async () => {
    expect(await probeWixRoute("https://example.com/condos")).toBe(200);
  });

  it("returns null when the host cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await probeWixRoute("https://example.com/condos")).toBeNull();
  });
});
