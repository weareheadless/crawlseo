import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureBusinessKnowledge,
  extractBusinessKnowledgeFromSite,
  BusinessKnowledgeMissingError,
} from "@/lib/projects/business-knowledge-extract";

/**
 * The extractor must read the text the crawl already stored. Refetching the same
 * pages was both slower and the main reason extraction failed on sites behind a
 * WAF, so the page source is asserted here, not assumed.
 */

const pages = [
  { url: "https://example.test/", title: "Atelier", contentScore: 90, contentText: "Atelier Céramique in Lyon. Handmade stoneware lamps." },
  { url: "https://example.test/services/lampes", title: "Lampes", contentScore: 70, contentText: "Lampes artisanales en grès, faites main à Lyon." },
  { url: "https://example.test/blog/entretien", title: "Entretien", contentScore: 40, contentText: "Comment entretenir une lampe en grès." },
];

function llm() {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          contentLanguage: "fr",
          businessName: "Atelier Céramique",
          services: ["Lampes artisanales"],
          location: "Lyon",
        }),
      },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubFetch(options: { sitemap?: string; page?: boolean } = {}) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) return new Response(options.sitemap ?? "<urlset></urlset>", { status: 200 });
    if (url.includes("/chat/completions")) return llm();
    if (options.page === false) throw new Error("network blocked");
    return new Response("<html><head><title>Page</title></head><body>Contenu</body></html>", { status: 200 });
  });
}

function db(crawlPages: typeof pages | null) {
  return {
    project: { findUniqueOrThrow: vi.fn(async () => ({ id: "p1", workspaceId: "w1", name: "Atelier", sites: [{ id: "s1", domain: "example.test" }] })) },
    evidenceRecord: { findMany: vi.fn(async () => []) },
    crawl: { findFirst: vi.fn(async () => (crawlPages ? { id: "c1" } : null)) },
    auditPage: {
      findMany: vi.fn(async (args: { select?: { contentText?: unknown } }) => {
        if (!crawlPages) return [];
        return args.select?.contentText
          ? crawlPages.map((page) => ({ url: page.url, title: page.title, contentText: page.contentText }))
          : crawlPages.map((page) => ({ url: page.url, contentScore: page.contentScore }));
      }),
    },
    businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("business knowledge extraction source", () => {
  it("reads the crawl's stored text instead of refetching the site", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    const fetch = stubFetch();
    vi.stubGlobal("fetch", fetch);

    const result = await extractBusinessKnowledgeFromSite(db(pages) as never, { projectId: "p1", siteId: "s1", dryRun: true });

    expect(result.pagesFromCrawl).toBe(3);
    expect(result.pagesFetched).toBe(0);
    expect(result.pagesUnreadable).toBe(0);
    expect(result.extracted).toEqual(["businessName", "services", "location"]);
    // Only the sitemap and the model were called: no page was re-fetched.
    const pageFetches = fetch.mock.calls.map(([url]) => String(url)).filter((url) => url === "https://example.test/");
    expect(pageFetches).toHaveLength(0);
  });

  it("falls back to fetching only when the site has no crawl", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    vi.stubGlobal("fetch", stubFetch());

    const result = await extractBusinessKnowledgeFromSite(db(null) as never, { projectId: "p1", siteId: "s1", dryRun: true });

    expect(result.pagesFromCrawl).toBe(0);
    expect(result.pagesFetched).toBeGreaterThan(0);
  });

  it("keeps a usable document and extracts nothing new", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const fake = db(null);
    (fake as unknown as { businessKnowledgeDocument: { findUnique: () => Promise<unknown> } }).businessKnowledgeDocument = {
      findUnique: vi.fn(async () => ({
        logicalId: "business-p1",
        revision: 3,
        revisions: [{ fields: { services: { value: ["Lampes artisanales"], provenance: { kind: "owner_input", status: "owner_confirmed" }, publicationUse: "approved" } } }],
      })),
    };

    const result = await ensureBusinessKnowledge(fake as never, { projectId: "p1", siteId: "s1" });

    expect(result.state).toBe("existing");
    expect(result.revision).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails with a named reason when no page can be read", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    vi.stubGlobal("fetch", stubFetch({ page: false }));

    await expect(ensureBusinessKnowledge(db(null) as never, { projectId: "p1", siteId: "s1" }))
      .rejects.toBeInstanceOf(BusinessKnowledgeMissingError);
    await expect(ensureBusinessKnowledge(db(null) as never, { projectId: "p1", siteId: "s1" }))
      .rejects.toThrow("BUSINESS_KNOWLEDGE_MISSING");
  });
});
