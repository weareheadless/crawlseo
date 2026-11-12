import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(async () => ({ status: "ok", route: "/abat-jour", pageId: "page-1", published: true })),
  chat: vi.fn(async () => ({
    title: "Abat-jour sur mesure dessiné pour votre luminaire",
    description: "Formes tambour ou coniques, dimensions relevées avec vous, tissus d’éditeurs et finition cousue.",
  })),
  live: vi.fn(async () => ""),
  render: vi.fn(async () => ""),
}));

vi.mock("@/lib/bridge/client", () => ({
  assertNegotiatedWixBridgeOperations: vi.fn(async () => undefined),
  readBridgePageSeo: h.read,
  setBridgePageSeo: h.write,
}));

vi.mock("@/lib/ai/chat", () => ({ chatJson: h.chat }));

// The model call is mocked, so the test supplies the config that would
// otherwise come from the host's environment. Production keeps requiring it.
vi.mock("@/lib/ai-seo/writer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-seo/writer")>();
  return {
    ...actual,
    contentWriterConfig: () => ({ apiKey: "test", baseUrl: "https://example.test/v1", model: "test-model" }),
  };
});

vi.mock("@/lib/delivery/wix-early-packet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/delivery/wix-early-packet")>();
  return { ...actual, readLivePage: h.live };
});

vi.mock("@/lib/delivery/wix-render", () => ({ renderPageDom: h.render, renderPageText: h.render }));

import { ensurePageSeo, htmlToText } from "@/lib/delivery/page-seo";

const livePage = (title: string, description: string) =>
  `<html><head><title>${title}</title><meta name="description" content="${description}"></head><body></body></html>`;

beforeEach(() => {
  h.read.mockReset();
  h.write.mockClear();
  h.chat.mockClear();
  h.live.mockReset();
  h.render.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("page SEO on push", () => {
  it("keeps a page's own title and description without writing anything", async () => {
    h.read.mockResolvedValue({
      status: "ok",
      route: "/abat-jour",
      pageId: "page-1",
      hasOverride: true,
      currentTitle: "Abat-jour sur mesure en Normandie",
      currentDescription: "Des abat-jours cousus main, sur mesure, dans l’atelier normand.",
    });
    h.live.mockResolvedValue(livePage(
      "Abat-jour sur mesure en Normandie",
      "Des abat-jours cousus main, sur mesure, dans l’atelier normand.",
    ));
    const result = await ensurePageSeo({
      alias: "atelier-harmonie",
      route: "/abat-jour",
      url: "https://example.test/abat-jour",
      siteName: "example.test",
      html: "<h1>Abat-jour</h1><p>Un texte de page assez long pour être décrit correctement.</p>",
    });
    expect(result.status).toBe("present");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("fills a page that still inherits the Wix pattern, then checks the live document", async () => {
    h.read.mockResolvedValue({
      status: "ok",
      route: "/abat-jour",
      pageId: "page-1",
      hasOverride: false,
      currentTitle: "abat-jour | Atelier",
      currentDescription: null,
    });
    h.live.mockResolvedValue(livePage(
      "Abat-jour sur mesure dessiné pour votre luminaire",
      "Formes tambour ou coniques, dimensions relevées avec vous, tissus d’éditeurs et finition cousue.",
    ));
    const result = await ensurePageSeo({
      alias: "atelier-harmonie",
      route: "/abat-jour",
      url: "https://example.test/abat-jour",
      siteName: "example.test",
      html: "<h1>Abat-jour sur mesure</h1><p>Formes tambour, conique ou dessinées selon votre lampe, avec le tissu de votre choix.</p>",
    });
    expect(result.status).toBe("updated");
    expect(result.source).toBe("model");
    expect(h.chat).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith(
      "atelier-harmonie",
      "/abat-jour",
      {
        title: "Abat-jour sur mesure dessiné pour votre luminaire",
        description: "Formes tambour ou coniques, dimensions relevées avec vous, tissus d’éditeurs et finition cousue.",
      },
      true,
    );
  });

  it("republishes tags the live page does not serve, even when the saved ones look right", async () => {
    h.read.mockResolvedValue({
      status: "ok",
      route: "/livraison",
      pageId: "page-1",
      hasOverride: true,
      currentTitle: "Livraison France et Europe : tarifs et seuils",
      currentDescription: "Frais de livraison selon destination et poids du panier, offerte dès 150 € en France.",
    });
    // A site publish restored an older page revision over the saved tags.
    h.live
      .mockResolvedValueOnce(livePage("Livraison | Atelier de l'Harmonie", ""))
      .mockResolvedValue(livePage("Livraison France et Europe : tarifs et seuils", "Frais de livraison selon destination et poids du panier, offerte dès 150 € en France."));
    const result = await ensurePageSeo({
      alias: "atelier-harmonie",
      route: "/livraison",
      url: "https://example.test/livraison",
      siteName: "example.test",
      html: "<h1>Livraison</h1><p>Frais de livraison selon la destination et le poids du panier.</p>",
    });
    expect(result.status).toBe("updated");
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it("uses the brief's title and description without asking the model", async () => {
    h.read.mockResolvedValue({ status: "ok", route: "/page", pageId: "page-1", hasOverride: false });
    h.live.mockResolvedValue(livePage("Titre écrit pour la page", "Description écrite pour la page, avec les faits du brief."));
    const result = await ensurePageSeo({
      alias: "atelier-harmonie",
      route: "/page",
      url: "https://example.test/page",
      siteName: "example.test",
      html: "<h1>Page</h1><p>Un contenu de page suffisamment long pour ne pas être considéré comme vide.</p>",
      seo: { title: "Titre écrit pour la page", description: "Description écrite pour la page, avec les faits du brief." },
    });
    expect(result.status).toBe("updated");
    expect(result.source).toBe("supplied");
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("reports a page whose live document still serves the old description", async () => {
    h.read.mockResolvedValue({ status: "ok", route: "/page", pageId: "page-1", hasOverride: false });
    h.live.mockResolvedValue(livePage("Ancien titre de page", "Ancienne description de page encore servie par le site."));
    const result = await ensurePageSeo({
      alias: "atelier-harmonie",
      route: "/page",
      url: "https://example.test/page",
      siteName: "example.test",
      html: "<h1>Page</h1><p>Un contenu de page suffisamment long pour ne pas être considéré comme vide.</p>",
      seo: { title: "Nouveau titre de page", description: "Nouvelle description de page avec les faits du brief." },
      retryDelayMs: 0,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("live document");
  });

  it("refuses to describe a page that has no copy", async () => {
    h.read.mockResolvedValue({ status: "ok", route: "/page", pageId: "page-1", hasOverride: false });
    h.live.mockResolvedValue("<html><head></head><body></body></html>");
    h.render.mockResolvedValue("<html><head></head><body></body></html>");
    const result = await ensurePageSeo({
      alias: "atelier-harmonie",
      route: "/page",
      url: "https://example.test/page",
      siteName: "example.test",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("too short");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("extracts readable copy without scripts or styles", () => {
    expect(htmlToText("<style>h1{color:red}</style><h1>Abat-jour</h1><script>var x = 1;</script><p>Cousu main.</p>"))
      .toBe("Abat-jour Cousu main.");
  });
});
