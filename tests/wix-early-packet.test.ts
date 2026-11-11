import { describe, expect, it, vi, afterEach } from "vitest";

import {
  buildEarlyPackets,
  buildPageComponentSource,
  checkComponentPlacement,
  pageComponentTag,
  PACKET_MAX_CHARACTERS,
} from "@/lib/delivery/wix-early-packet";

/** A deterministic payload that gzip cannot shrink, so chunking is exercised. */
function pseudoRandom(length: number): string {
  let seed = 12345;
  let value = "";
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    value += String.fromCharCode(33 + (seed % 90));
  }
  return value;
}

const fragment = `<section data-crawlseo-task="task-1"><style>[data-crawlseo-task="task-1"] h1{color:#87475b}</style><h1>Abat-jour sur mesure</h1><script type="application/ld+json">{"@type":"WebPage"}</script></section>`;

describe("page component tag", () => {
  it("keeps the site's shared prefix and adds the route slug", () => {
    expect(pageComponentTag("/abat-jour-sur-mesure", ["atelier-navbar-v1", "atelier-home-v1"]))
      .toBe("atelier-abat-jour-sur-mesure-v1");
  });

  it("flattens a nested route into one tag", () => {
    expect(pageComponentTag("/lampes/abat-jours", ["atelier-navbar-v1"])).toBe("atelier-lampes-abat-jours-v1");
  });

  it("uses a neutral prefix when the site has no shared one", () => {
    expect(pageComponentTag("/abat-jour-sur-mesure", ["home-about-v1", "listing-detail-v1"]))
      .toBe("crawlseo-abat-jour-sur-mesure-v1");
  });

  it("rejects a route with no usable slug", () => {
    expect(() => pageComponentTag("/---", [])).toThrow();
  });
});

describe("page component source", () => {
  it("defines the tag once and renders the reviewed fragment", () => {
    const source = buildPageComponentSource({ tag: "atelier-abat-jour-sur-mesure-v1", html: fragment, taskId: "task-1" });
    expect(source).toContain('const TAG = "atelier-abat-jour-sur-mesure-v1"');
    expect(source).toContain("if (customElements.get(TAG)) return;");
    expect(source).toContain("customElements.define(TAG, CrawlSeoPage);");
    expect(source).toContain("Abat-jour sur mesure");
  });

  it("moves structured data to the document head", () => {
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: fragment, taskId: "task-1" });
    expect(source).toContain('script[type="application/ld+json"]');
    expect(source).toContain("document.head.append(copy)");
  });

  it("rejects an invalid tag", () => {
    expect(() => buildPageComponentSource({ tag: "notatag", html: fragment, taskId: "task-1" })).toThrow();
  });
});

describe("early packets", () => {
  it("builds one packet for a small source", () => {
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: fragment, taskId: "task-1" });
    const packets = buildEarlyPackets({ tag: "atelier-x-v1", route: "/abat-jour-sur-mesure", source });
    expect(packets).toHaveLength(1);
    expect(packets[0].count).toBe(1);
    expect(packets[0].html.length).toBeLessThan(PACKET_MAX_CHARACTERS);
  });

  it("guards the packet by route and by the site's early-elements switch", () => {
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: fragment, taskId: "task-1" });
    const [packet] = buildEarlyPackets({ tag: "atelier-x-v1", route: "/abat-jour-sur-mesure", source });
    expect(packet.html).toContain('"/abat-jour-sur-mesure"');
    expect(packet.html).toContain('get("earlyElements")==="off"');
    expect(packet.html).toContain("customElements.get");
  });

  it("splits a long source into ordered chunks that stay under the Wix limit", () => {
    // A repeated fragment compresses to almost nothing; this payload does not.
    const noisy = pseudoRandom(12_000);
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: `<section>${noisy}</section>`, taskId: "task-1" });
    const packets = buildEarlyPackets({ tag: "atelier-x-v1", route: "/long", source, chunkCharacters: 2_000 });
    expect(packets.length).toBeGreaterThan(1);
    expect(packets.map((packet) => packet.index)).toEqual(packets.map((_, index) => index));
    for (const packet of packets) expect(packet.html.length).toBeLessThan(PACKET_MAX_CHARACTERS);
    // Only the last chunk decompresses; the earlier ones only store their part.
    expect(packets.at(-1)?.html).toContain("DecompressionStream");
    expect(packets[0].html).not.toContain("DecompressionStream");
  });

  it("refuses a chunk that would exceed the Wix limit", () => {
    const noisy = pseudoRandom(30_000);
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: `<section>${noisy}</section>`, taskId: "task-1" });
    expect(() => buildEarlyPackets({ tag: "atelier-x-v1", route: "/x", source, chunkCharacters: 20_000 })).toThrow();
  });
});

describe("placement check", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("finds the element in the rendered document", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "<main><atelier-x-v1></atelier-x-v1></main>" }));
    expect(await checkComponentPlacement("https://example.com/x", "atelier-x-v1")).toBe("found");
  });

  it("reports a page without the element as missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "<main></main>" }));
    expect(await checkComponentPlacement("https://example.com/x", "atelier-x-v1")).toBe("missing");
  });

  it("reports an unreachable page as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await checkComponentPlacement("https://example.com/x", "atelier-x-v1")).toBe("unavailable");
  });
});
