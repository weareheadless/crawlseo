import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/chat", () => ({
  chatJson: vi.fn(async () => ({
    contentLanguage: "en",
    businessName: "Canonical Joinery",
    services: ["fitted wardrobes"],
    market: "United Kingdom",
  })),
}));

vi.mock("@/lib/ai-seo/writer", () => ({
  contentWriterConfig: () => ({ apiKey: "test", baseUrl: "http://model.test", model: "fixture" }),
}));

import { extractBusinessKnowledgeFromSite } from "@/lib/projects/business-knowledge-extract";

/**
 * The extractor reads the site it was asked for, from the crawl it already has.
 *
 * It used to take the project's first site ordered by creation date, so a project
 * with a preview mirror and a production site could extract the preview's facts
 * and assess the production site's needs against them.
 *
 * It also used to re-fetch ten URLs over HTTP instead of reading the text the
 * crawl had already stored. That path read 10 of casamigo's 483 pages, collapsed
 * to one page on the two tenants whose /sitemap.xml is a 404, and never read the
 * /about page where the country was written.
 */

function fakeDb(siteId: string) {
  return {
    project: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "project-1",
        workspaceId: "workspace-1",
        name: "Joinery",
        sites: [{ id: "site-canonical", domain: "canonical.test" }],
      })),
    },
    crawl: {
      findFirst: vi.fn(async () => ({ id: `crawl-${siteId}` })),
    },
    auditPage: {
      findMany: vi.fn(async () => [
        {
          url: "https://canonical.test/",
          title: "Canonical Joinery",
          wordCount: 60,
          contentText: "We make fitted wardrobes in Bristol, United Kingdom. ".repeat(4),
        },
        {
          url: "https://canonical.test/about",
          title: "About",
          wordCount: 80,
          contentText: "A workshop in Bristol serving the South West. ".repeat(4),
        },
      ]),
    },
    businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
  } as never;
}

describe("business knowledge extraction site selection", () => {
  it("reads the requested site, not the project's oldest site", async () => {
    const db = fakeDb("site-canonical");
    await extractBusinessKnowledgeFromSite(db, {
      projectId: "project-1",
      siteId: "site-canonical",
      dryRun: true,
    });

    const project = (db as unknown as { project: { findUniqueOrThrow: ReturnType<typeof vi.fn> } }).project;
    const args = project.findUniqueOrThrow.mock.calls[0][0] as {
      select: { sites: { where?: { id?: string } } };
    };
    expect(args.select.sites.where?.id).toBe("site-canonical");
  });

  it("reads the crawl's stored text instead of fetching pages over HTTP", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response("not found", { status: 404 });
    });

    const db = fakeDb("site-canonical");
    const result = await extractBusinessKnowledgeFromSite(db, {
      projectId: "project-1",
      siteId: "site-canonical",
      dryRun: true,
    });

    // No page is fetched: the crawl already has the text, and re-fetching is what
    // made a 404 sitemap decide how much of the site was read.
    expect(fetched).toEqual([]);
    expect(result.pagesRead).toBe(2);
    expect(result.pageUrls).toEqual([
      "https://canonical.test/",
      "https://canonical.test/about",
    ]);
    vi.unstubAllGlobals();
  });

  it("reports how many crawled pages were not sent", async () => {
    const db = fakeDb("site-canonical");
    const result = await extractBusinessKnowledgeFromSite(db, {
      projectId: "project-1",
      siteId: "site-canonical",
      dryRun: true,
    });
    // Two pages, both sent: the count is present even when nothing was dropped,
    // so a reader never has to guess whether a bound applied.
    expect(result.skipped).toEqual({ pages: 0, reason: "" });
  });

  it("refuses when the site has no crawl with stored text", async () => {
    const db = {
      project: {
        findUniqueOrThrow: async () => ({
          id: "project-1",
          workspaceId: "workspace-1",
          name: "Joinery",
          sites: [{ id: "site-canonical", domain: "canonical.test" }],
        }),
      },
      crawl: { findFirst: async () => null },
      auditPage: { findMany: async () => [] },
      businessKnowledgeDocument: { findUnique: async () => null },
    } as never;

    await expect(
      extractBusinessKnowledgeFromSite(db, { projectId: "project-1", siteId: "site-canonical", dryRun: true })
    ).rejects.toThrow(/no completed crawl with stored page text/);
  });
});
