import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const extract = vi.hoisted(() =>
  vi.fn(async () => ({
    extracted: ["services"],
    pagesRead: 1,
    pageUrls: ["https://site.test/"],
    contentLanguage: "en",
    fields: { services: { value: ["Fitted wardrobes"] } },
    revision: 1,
  }))
);

vi.mock("@/lib/projects/business-knowledge-extract", () => ({
  extractBusinessKnowledgeFromSite: extract,
}));
vi.mock("@/lib/site/context", () => ({
  MissingSiteContextError: class MissingSiteContextError extends Error {},
  resolveSiteContext: vi.fn(async () => ({
    language: "en",
    country: "GB",
    audienceCountry: null,
    audience: null,
    market: null,
    audienceMarket: null,
    location: null,
    source: { country: "GB", audienceCountry: null },
  })),
}));

import { ensureTenantAnalysis, inspectTenant } from "@/lib/tenants/analysis";

function tenantDb(fields: Record<string, unknown> | null) {
  const siteProfileUpsert = vi.fn(async () => ({}));
  const db = {
    site: {
      findUnique: vi.fn(async () => ({
        id: "s1",
        domain: "site.test",
        projectId: "p1",
        userId: "u1",
        retiredAt: null,
        siteProfile: { topics: ["Fitted wardrobes"], audience: null, language: "en", constraints: null },
        researchPolicy: { enabled: true, cadence: "monthly", providers: [], recencyDays: 90 },
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: "s1",
        domain: "site.test",
        projectId: "p1",
        userId: "u1",
        siteProfile: { topics: ["Fitted wardrobes"], audience: null },
      })),
      count: vi.fn(async () => 0),
    },
    businessKnowledgeDocument: {
      findUnique: vi.fn(async () => ({
        revision: 1,
        acceptedRevision: null,
        revisions: [{ fields }],
      })),
    },
    crawl: {
      findFirst: vi.fn(async () => ({ id: "c1", finishedAt: new Date(), pagesFound: 10, maxPages: 500 })),
    },
    researchRun: {
      findFirst: vi.fn(async () => ({
        id: "r1",
        status: "COMPLETED",
        createdAt: new Date(),
        findingCount: 1,
        sourceCount: 1,
        errorCode: null,
      })),
    },
    opportunity: { count: vi.fn(async () => 1) },
    siteProfile: { upsert: siteProfileUpsert },
    keyword: { findMany: vi.fn(async () => []) },
  };
  return { db, siteProfileUpsert };
}

describe("tenant business-knowledge bootstrap", () => {
  it("treats a document with no usable facts as missing", async () => {
    const { db } = tenantDb({ contentLanguage: { value: "en" } });
    const analysis = await inspectTenant(db as never, "s1");
    const step = analysis.steps.find((entry) => entry.step === "business-knowledge");
    expect(step?.status).toBe("missing");
    expect(step?.detail).toMatch(/no usable business facts/);
  });

  it("keeps a document with usable facts as ok", async () => {
    const { db } = tenantDb({ services: { value: ["Fitted wardrobes"] } });
    const analysis = await inspectTenant(db as never, "s1");
    expect(analysis.steps.find((entry) => entry.step === "business-knowledge")?.status).toBe("ok");
  });

  it("uses the shared tenant bootstrap in the evaluation script", () => {
    const source = readFileSync("scripts/evaluate-need-assessment.ts", "utf8");
    expect(source).toContain("ensureTenantAnalysis");
    expect(source).not.toContain("extractBusinessKnowledgeFromSite");
  });

  it("runs the same extraction in dry-run mode without writing", async () => {
    const { db, siteProfileUpsert } = tenantDb({ contentLanguage: { value: "en" } });
    const analysis = await ensureTenantAnalysis(db as never, "s1", { dryRun: true });
    expect(extract).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: "p1", siteId: "s1", dryRun: true })
    );
    expect(siteProfileUpsert).not.toHaveBeenCalled();
    expect(analysis.extraction?.extracted).toEqual(["services"]);
  });
});
