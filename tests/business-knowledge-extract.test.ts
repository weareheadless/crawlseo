import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/chat", () => ({
  chatJson: vi.fn(async () => ({
    contentLanguage: "en",
    businessName: "Canonical Joinery",
    services: ["fitted wardrobes"],
  })),
}));

vi.mock("@/lib/ai-seo/writer", () => ({
  contentWriterConfig: () => ({ apiKey: "test", baseUrl: "http://model.test", model: "fixture" }),
}));

import { extractBusinessKnowledgeFromSite } from "@/lib/projects/business-knowledge-extract";

/**
 * The extractor reads the site it was asked for.
 *
 * It used to take the project's first site, ordered by creation date. A project
 * with a preview mirror and a production site could therefore extract the preview's
 * facts and assess the production site's needs against them.
 */
describe("business knowledge extraction site selection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the requested site, not the project's oldest site", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/sitemap.xml")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        "<html><head><title>Canonical Joinery</title></head><body>We make fitted wardrobes in Bristol.</body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
    });

    const findUniqueOrThrow = vi.fn(async () => ({
      id: "project-1",
      workspaceId: "workspace-1",
      name: "Joinery",
      sites: [{ id: "site-canonical", domain: "canonical.test" }],
    }));
    const db = {
      project: { findUniqueOrThrow },
      evidenceRecord: { findMany: vi.fn(async () => []) },
      businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
    } as never;

    const result = await extractBusinessKnowledgeFromSite(db, {
      projectId: "project-1",
      siteId: "site-canonical",
      dryRun: true,
    });

    expect(result.pagesRead).toBeGreaterThan(0);
    expect(result.extracted).toContain("services");
    const calls = findUniqueOrThrow.mock.calls as unknown as Array<[unknown]>;
    const args = calls[0][0] as {
      select: { sites: { where?: { id?: string } } };
    };
    expect(args.select.sites.where?.id).toBe("site-canonical");
    expect(requested.every((url) => url.startsWith("https://canonical.test"))).toBe(true);
  });
});
