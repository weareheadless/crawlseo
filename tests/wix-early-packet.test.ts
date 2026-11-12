import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/delivery/wix-render", () => ({ renderPageDom: vi.fn() }));

import { renderPageDom } from "@/lib/delivery/wix-render";

import {
  buildEarlyPackets,
  buildMountEmbed,
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

  it("adds the locale to a non-default page tag without repeating the prefix", () => {
    expect(pageComponentTag("/en/abat-jour-sur-mesure", ["atelier-navbar-v1"], "en"))
      .toBe("atelier-abat-jour-sur-mesure-en-v1");
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

  it("sets a translated page's title and description from the component", () => {
    const source = buildPageComponentSource({
      tag: "atelier-agenda-en-v1",
      html: "<h1>Agenda</h1>",
      taskId: "task-1",
      seo: { title: "Craft fairs in Normandy", description: "Checked every week.", locale: "en" },
    });
    expect(source).toContain('const SEO = {"title":"Craft fairs in Normandy"');
    expect(source).toContain("document.title = SEO.title");
    expect(source).toContain('meta[name="description"]');
    expect(source).toContain('meta[property="og:locale"]');
  });

  it("does not touch the document title when the page sets none", () => {
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: "<h1>X</h1>", taskId: "task-1" });
    expect(source).toContain("const SEO = null;");
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

  it("keeps the default locale off another locale's prefix", () => {
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: fragment, taskId: "task-1" });
    const [french] = buildEarlyPackets({ tag: "atelier-x-v1", route: "/abat-jour-sur-mesure", source, alternateRoute: "/fr/abat-jour-sur-mesure" });
    const [english] = buildEarlyPackets({ tag: "atelier-x-en-v1", route: "/en/abat-jour-sur-mesure", source });
    expect(french.html).toContain('"/fr/abat-jour-sur-mesure"');
    expect(french.html).toContain("p!==r&&p!==a");
    expect(english.html).toContain("p!==r)return");
    expect(english.html).not.toContain("/fr/abat-jour-sur-mesure");
  });

  it("requires the locale query and excludes the other locale on a shared route", () => {
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: fragment, taskId: "task-1" });
    const [spanish] = buildEarlyPackets({ tag: "atelier-x-es-v1", route: "/x", source, query: { key: "lang", value: "es" } });
    const [english] = buildEarlyPackets({ tag: "atelier-x-v1", route: "/x", source, excludeQuery: { key: "lang", value: "es" } });
    expect(spanish.html).toContain('get("lang")!=="es"');
    expect(english.html).toContain('get("lang")==="es"');
  });

  it("registers the element and leaves mounting to the page embed", () => {
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: fragment, taskId: "task-1" });
    const [packet] = buildEarlyPackets({ tag: "atelier-x-v1", route: "/x", source });
    expect(packet.html).toContain("customElements.get");
    expect(packet.html).not.toContain("PAGES_CONTAINER");
    expect(packet.html).not.toContain("replaceChildren");
  });

  it("splits a long source into ordered chunks that stay under the Wix limit", () => {
    // A repeated fragment compresses to almost nothing; this payload does not.
    const noisy = pseudoRandom(12_000);
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: `<section>${noisy}</section>`, taskId: "task-1" });
    const packets = buildEarlyPackets({ tag: "atelier-x-v1", route: "/long", source, chunkCharacters: 2_000 });
    expect(packets.length).toBeGreaterThan(1);
    expect(packets.map((packet) => packet.index)).toEqual(packets.map((_, index) => index));
    for (const packet of packets) expect(packet.html.length).toBeLessThan(PACKET_MAX_CHARACTERS);
    // Every chunk can complete the set: the store is indexed, not appended.
    for (const packet of packets) {
      expect(packet.html).toContain("parts[i]=");
      expect(packet.html).toContain("Object.keys(e.parts).length!==c");
    }
  });

  it("reassembles the source from chunks in any order and survives repeated runs", async () => {
    const tag = "atelier-order-test-v1";
    const source = `customElements.define("${tag}", class extends HTMLElement {});`;
    const packets = buildEarlyPackets({ tag, route: "/x", source, chunkCharacters: 80 });
    expect(packets.length).toBeGreaterThan(1);

    const defined: string[] = [];
    const injected: string[] = [];
    const customElements = {
      get: (name: string) => (defined.includes(name) ? class {} : undefined),
      define: (name: string) => { defined.push(name); },
    };
    const document = {
      createElement: () => ({ textContent: "" }),
      head: {
        append: (script: { textContent: string }) => {
          injected.push(script.textContent);
          new Function("customElements", "HTMLElement", script.textContent)(customElements, class {});
        },
      },
    };
    const windowObject: Record<string, unknown> = {};
    const run = (html: string) => {
      const code = html.replace(/^<script>/, "").replace(/<\/script>$/, "");
      new Function(
        "window", "location", "URLSearchParams", "atob", "Uint8Array", "Object", "Array",
        "DecompressionStream", "Blob", "Response", "customElements", "document", "HTMLElement",
        code,
      )(windowObject, { pathname: "/x", search: "" }, URLSearchParams, atob, Uint8Array, Object, Array,
        DecompressionStream, Blob, Response, customElements, document, class {});
    };

    // Reverse order, each chunk twice, is the worst case Wix can produce when
    // it reruns a page's custom code inside one document.
    for (const packet of [...packets].reverse()) {
      run(packet.html);
      run(packet.html);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(defined).toEqual([tag]);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain(`customElements.define("${tag}"`);
  });

  it("refuses a chunk that would exceed the Wix limit", () => {
    const noisy = pseudoRandom(30_000);
    const source = buildPageComponentSource({ tag: "atelier-x-v1", html: `<section>${noisy}</section>`, taskId: "task-1" });
    expect(() => buildEarlyPackets({ tag: "atelier-x-v1", route: "/x", source, chunkCharacters: 20_000 })).toThrow();
  });
});

describe("mount embed", () => {
  it("puts the element on the page and keeps re-mounting through hydration", () => {
    const mount = buildMountEmbed({ tag: "atelier-x-v1", route: "/x" });
    expect(mount.name).toBe("CrawlSEO page mount — atelier-x-v1");
    expect(mount.html).toContain('document.getElementById("PAGES_CONTAINER")');
    expect(mount.html).toContain('createElement("atelier-x-v1")');
    expect(mount.html).toContain("replaceChildren(el)");
    expect(mount.html).toContain("setTimeout(()=>o.disconnect(),60000)");
    expect(mount.html).not.toContain("if(mount())o.disconnect()");
  });

  it("keeps the mount on its own route and locale", () => {
    const mount = buildMountEmbed({ tag: "atelier-x-v1", route: "/x", alternateRoute: "/fr/x" });
    expect(mount.html).toContain('"/x"');
    expect(mount.html).toContain('"/fr/x"');
    expect(mount.html).toContain('get("earlyElements")==="off"');
  });
});

describe("placement check", () => {
  afterEach(() => vi.mocked(renderPageDom).mockReset());

  it("finds the element in the rendered document", async () => {
    vi.mocked(renderPageDom).mockResolvedValue("<main><atelier-x-v1></atelier-x-v1></main>");
    expect(await checkComponentPlacement("https://example.com/x", "atelier-x-v1")).toBe("found");
  });

  it("reports a page without the element as missing", async () => {
    vi.mocked(renderPageDom).mockResolvedValue("<main></main>");
    expect(await checkComponentPlacement("https://example.com/x", "atelier-x-v1", { attempts: 1 })).toBe("missing");
  });

  it("reports an unrenderable page as unavailable", async () => {
    vi.mocked(renderPageDom).mockResolvedValue(null);
    expect(await checkComponentPlacement("https://example.com/x", "atelier-x-v1")).toBe("unavailable");
  });
});
