/* eslint-disable @typescript-eslint/no-explicit-any -- a fake bridge keeps this contract test focused. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state: any = {
    site: { id: "site-1", domain: "example.com", retiredAt: null },
    config: { enabled: true, bridgeAlias: "example", repoPath: null },
    snippets: [] as Array<{ id: string; name: string }>,
    created: [] as any[],
    written: [] as any[],
    disabled: [] as string[],
  };
  const db: any = {
    site: { findUnique: vi.fn(async () => state.site) },
    deliveryTarget: { findUnique: vi.fn(async () => null) },
  };
  return { state, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/site-delivery/config", () => ({
  getSiteDeliveryConfig: vi.fn(async () => h.state.config),
}));
vi.mock("@/lib/delivery/wix-render", () => ({
  renderPageDom: vi.fn(async () => null),
  probeWixRoute: vi.fn(async () => 200),
}));
vi.mock("@/lib/bridge/client", () => ({
  assertNegotiatedWixBridgeOperations: vi.fn(async () => undefined),
  listBridgeSnippets: vi.fn(async () => ({ snippets: h.state.snippets })),
  createBridgeSnippet: vi.fn(async (_alias: string, input: any) => {
    h.state.created.push(input);
    const id = `embed-${h.state.created.length}`;
    h.state.snippets.push({ id, name: input.name });
    return { customEmbedId: id };
  }),
  writeBridgePacket: vi.fn(async (_alias: string, id: string, file: string) => {
    h.state.written.push({ id, file });
    return { status: "updated" };
  }),
  readBridgeEmbed: vi.fn(async () => ({ embed: { htmlSha256: null } })),
  disableBridgeEmbed: vi.fn(async (_alias: string, id: string) => {
    h.state.disabled.push(id);
    return { status: "disabled" };
  }),
}));

import { deliverWixPageComponent } from "@/lib/delivery/wix-early-packet";

const html = "<section><style>h1{color:red}</style><h1>Condos</h1></section>";

beforeEach(() => {
  h.state.site = { id: "site-1", domain: "example.com", retiredAt: null };
  h.state.config = { enabled: true, bridgeAlias: "example", repoPath: null };
  h.state.snippets = [];
  h.state.created = [];
  h.state.written = [];
  h.state.disabled = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Wix component delivery", () => {
  it("deploys the packet and the mount as two separate embeds", async () => {
    const result = await deliverWixPageComponent({ siteId: "site-1", route: "/condos", html, taskId: "task-1" });

    expect(h.state.created.map((embed: any) => [embed.name, embed.position])).toEqual([
      [`CrawlSEO early packet — ${result.tag} — 1`, "HEAD"],
      [`CrawlSEO page mount — ${result.tag}`, "BODY_END"],
    ]);
    // The packet registers the element; only the mount touches the container.
    expect(h.state.created[0].htmlFile).toBeTruthy();
    expect(result.mount.name).toBe(`CrawlSEO page mount — ${result.tag}`);
    expect(result.packets).toHaveLength(1);
  });

  it("reuses the existing mount embed on a retry instead of creating a duplicate", async () => {
    const first = await deliverWixPageComponent({ siteId: "site-1", route: "/condos", html, taskId: "task-1" });
    h.state.created = [];

    const second = await deliverWixPageComponent({ siteId: "site-1", route: "/condos", html, taskId: "task-1" });

    expect(h.state.created).toHaveLength(0);
    expect(second.mount.id).toBe(first.mount.id);
    expect(second.mount.created).toBe(false);
    expect(second.packets[0].created).toBe(false);
    expect(h.state.written.length).toBe(2);
  });

  it("gives each locale its own tag, packet and mount", async () => {
    const fr = await deliverWixPageComponent({ siteId: "site-1", route: "/condos", html, taskId: "task-1" });
    const en = await deliverWixPageComponent({
      siteId: "site-1",
      route: "/en/condos",
      html,
      taskId: "task-1",
      localeCode: "en",
    });

    expect(en.tag).not.toBe(fr.tag);
    expect(en.mount.name).not.toBe(fr.mount.name);
    expect(en.packets[0].id).not.toBe(fr.packets[0].id);
  });
});
