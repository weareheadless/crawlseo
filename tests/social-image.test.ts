import { describe, expect, it, vi } from "vitest";
import { assetId, pagesAbout, photoFrom, resolveImage, shareImageFrom, subjectTokens } from "@/lib/social/image";

const PAGES = [
  "https://www.susimacdonald.com/riviera-maya-condos-sale-under-200k",
  "https://www.susimacdonald.com/tulum-condos-sale",
  "https://www.susimacdonald.com/post/how-safe-is-the-riviera-maya-the-truth-behind-the-headlines",
];

function html(head: string) {
  return new Response(`<!doctype html><html><head>${head}</head><body>x</body></html>`, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

describe("matching a page to a subject", () => {
  it("keeps the words that identify it", () => {
    expect(subjectTokens("Playa del Carmen")).toEqual(["playa", "carmen"]);
    expect(subjectTokens("Puerto Morelos")).toEqual(["puerto", "morelos"]);
  });

  it("needs every token, not one", () => {
    expect(pagesAbout("Tulum", PAGES)).toEqual([PAGES[1]]);
    expect(pagesAbout("Under $200k", PAGES)).toEqual([PAGES[0]]);
    expect(pagesAbout("Akumal", PAGES)).toEqual([]);
  });
});

describe("shareImageFrom", () => {
  it("reads og:image in either attribute order", () => {
    expect(shareImageFrom('<meta property="og:image" content="https://cdn.example/a.jpg">', PAGES[0])?.url)
      .toBe("https://cdn.example/a.jpg");
    expect(shareImageFrom('<meta content="https://cdn.example/b.jpg" property="og:image">', PAGES[0])?.url)
      .toBe("https://cdn.example/b.jpg");
  });

  it("resolves a relative image against the page", () => {
    expect(shareImageFrom('<meta property="og:image" content="/wp-content/x.jpg">', PAGES[0])?.url)
      .toBe("https://www.susimacdonald.com/wp-content/x.jpg");
  });

  it("returns nothing when the page declares no image", () => {
    expect(shareImageFrom("<title>No image</title>", PAGES[0])).toBeNull();
  });
});

describe("photoFrom", () => {
  it("takes the largest photograph and never the share card", () => {
    const html = [
      '<meta property="og:image" content="https://cdn.example/media/share.png/v1/fit/w_2500/share.png">',
      '<img src="https://cdn.example/media/a.jpg/v1/fill/w_28,h_28/al_c/icon.png">',
      '<img src="https://cdn.example/media/b.jpg/v1/fill/w_1024,h_569/al_c/q_75/facade.jpg">',
      '<img src="https://cdn.example/media/b.jpg/v1/fill/w_1600,h_889/al_c/q_75/facade.jpg">',
      '<img src="https://cdn.example/media/logo-wide.png/v1/fill/w_2000,h_80/al_c/logo.png">',
    ].join("");
    const share = shareImageFrom(html, "https://example.com/page")!;
    expect(photoFrom(html, [assetId(share.url)])?.url).toContain("w_1600");
  });

  it("returns nothing when the only large image is the share card", () => {
    const html = '<meta property="og:image" content="https://cdn.example/media/share.png/v1/fit/w_2500/share.png">' +
      '<img src="https://cdn.example/media/x.png/v1/fill/w_56,h_56/al_c/icon.png">';
    const share = shareImageFrom(html, "https://example.com/page")!;
    expect(photoFrom(html, [assetId(share.url)])).toBeNull();
  });

  it("returns nothing when every image is a thumbnail or a logo", () => {
    expect(photoFrom('<img src="https://cdn.example/x.png/v1/fill/w_28/h_28/icon.png">')).toBeNull();
  });
});

describe("resolveImage", () => {
  it("uses a photograph from the site's own page about the subject", async () => {
    const fetchImpl = vi.fn(async () =>
      html('<meta property="og:image" content="https://cdn.example/media/share.png/v1/fit/w_2500/logo.png">' +
        '<img src="https://cdn.example/media/villa.jpg/v1/fill/w_1600,h_889/al_c/villa.jpg">'),
    );
    const resolved = await resolveImage({
      subject: "Tulum",
      pages: PAGES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(resolved).toMatchObject({
      source: "page",
      url: "https://cdn.example/media/villa.jpg/v1/fill/w_1600,h_889/al_c/villa.jpg",
      pageUrl: PAGES[1],
    });
  });

  it("does not mistake the site's share card for a photograph", async () => {
    const fetchImpl = vi.fn(async () =>
      html('<meta property="og:image" content="https://cdn.example/media/share.png/v1/fit/w_2500/logo.png">'),
    );
    const findStock = vi.fn(async () => ({ url: "https://images.example/tulum.jpg", alt: "Tulum", credit: "Photo: someone" }));
    const resolved = await resolveImage({
      subject: "Tulum",
      pages: PAGES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      findStock,
    });
    expect(resolved.source).toBe("unsplash");
    expect(findStock).toHaveBeenCalled();
  });

  it("falls back to a stock photograph for a subject with no page", async () => {
    const fetchImpl = vi.fn(async () => html("<title>nothing</title>"));
    const findStock = vi.fn(async () => ({
      url: "https://images.example/xcalacoco.jpg",
      alt: "Coast at Xcalacoco",
      credit: "Photo: someone / Unsplash",
    }));
    const resolved = await resolveImage({
      subject: "Xcalacoco",
      pages: PAGES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      findStock,
    });
    expect(resolved).toMatchObject({ source: "unsplash", url: "https://images.example/xcalacoco.jpg" });
    expect(findStock).toHaveBeenCalledWith("Xcalacoco");
  });

  it("says why there is no image rather than inventing one", async () => {
    const resolved = await resolveImage({
      subject: "Xcalacoco",
      pages: PAGES,
      fetchImpl: vi.fn(async () => html("<title>nothing</title>")) as unknown as typeof fetch,
    });
    expect(resolved).toMatchObject({ source: "none" });
    expect(resolved.source === "none" && resolved.reason).toContain("no page on the site is about Xcalacoco");
  });

  it("does not fall through to stock when the page fetch merely failed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const findStock = vi.fn(async () => null);
    const resolved = await resolveImage({
      subject: "Tulum",
      pages: PAGES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      findStock,
    });
    expect(findStock).toHaveBeenCalled();
    expect(resolved.source).toBe("none");
  });
});
