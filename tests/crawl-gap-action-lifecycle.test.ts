import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sites: new Map<string, { domain: string; projectId: string }>(),
  issues: new Map<string, Array<Record<string, unknown>>>(),
  actions: [] as Array<Record<string, unknown>>,
  crawlId: "crawl-1",
  acceptedRevision: 3,
}));

vi.mock("@/lib/db", () => ({ db: {
  site: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => mocks.sites.get(where.id) ?? null) },
  crawl: { findFirst: vi.fn(async ({ where }: { where: { siteId: string } }) => ({ id: mocks.crawlId, pagesFound: 1, finishedAt: new Date(), siteId: where.siteId })) },
  crawlIssue: { findMany: vi.fn(async ({ where }: { where: { crawlId: string } }) => mocks.issues.get(where.crawlId) ?? []) },
  auditPage: { findMany: vi.fn(async () => [{ url: "https://example.com/", title: "Company", description: "", wordCount: 20, contentScore: 90, h1Count: 1, statusCode: 200 }]) },
  auditLink: { findMany: vi.fn(async () => []) },
  researchAction: {
    findMany: vi.fn(async ({ where }: { where: { projectId?: string; siteId?: string } }) => mocks.actions.filter(a => where.projectId ? a.projectId === where.projectId : a.siteId === where.siteId)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const a = mocks.actions.find(v => v.id === where.id)!; Object.assign(a, data); return a; }),
  },
  businessKnowledgeDocument: { findUnique: vi.fn(async () => ({ logicalId: "knowledge-1", acceptedRevision: mocks.acceptedRevision })) },
} }));
vi.mock("@/lib/research/service", () => ({ createResearchAction: vi.fn(async (siteId: string, input: Record<string, unknown>) => {
  const site = mocks.sites.get(siteId)!;
  mocks.actions.push({ id: `action-${mocks.actions.length + 1}`, siteId, projectId: site.projectId, status: "PROPOSED", ...input });
  return { created: true };
}) }));
vi.mock("@/lib/agent-tasks/targets", () => ({ isWixBlogTarget: () => false }));
vi.mock("@/lib/research/crawl-live-check", () => ({ verifyCrawlDraftLive: async () => null, identityJsonLdMatchesAcceptedRevision: () => ({ passed: false, mismatchedFields: ["businessName"], requiredFields: ["businessName"] }), schemaAuditProjection: () => null }));

import { syncCrawlIssuesToActions } from "@/lib/research/crawl-actions";

const url = "https://example.com/";
function findings(crawlId: string, observed: string) {
  return [
    { url, type: "MISSING_SCHEMA", severity: "INFO", message: "No JSON-LD identity", details: { kind: "identity_jsonld_absence", knowledgeDocumentId: "knowledge-1", knowledgeRevision: mocks.acceptedRevision } },
    { url, type: "MISSING_SCHEMA", severity: "WARNING", message: "identity mismatch", details: { kind: "business_schema_semantics", stableKey: `${url}:name`, field: "name", status: "mismatch", expected: "Owner Co", observed, evidence: `observed:${observed}` } },
    { url: "https://example.com/robots.txt", type: "MISSING_SCHEMA", severity: "WARNING", message: "GPTBot blocked", details: { kind: "ai_crawler_block", gapIdentity: "robots:GPTBot:Disallow:/", crawler: "GPTBot", rule: "Disallow: /" } },
    { url, type: "MISSING_SCHEMA", severity: "WARNING", message: "Not in sitemap", details: { kind: "sitemap_coverage", gapIdentity: `sitemap:${url}`, page: url } },
  ].map(issue => ({ ...issue, crawlId }));
}

describe("re-runnable crawl gap Action verification", () => {
  beforeEach(() => {
    mocks.sites.clear(); mocks.issues.clear(); mocks.actions.length = 0; mocks.crawlId = "crawl-1";
    mocks.sites.set("site-a", { domain: "example.com", projectId: "project-a" });
  });
  it("deduplicates unchanged gaps, refreshes evidence, then fulfills cleared conditions", async () => {
    mocks.issues.set("crawl-1", findings("crawl-1", "Wrong A"));
    await syncCrawlIssuesToActions("site-a");
    expect(mocks.actions).toHaveLength(4);
    mocks.crawlId = "crawl-2"; mocks.issues.set("crawl-2", findings("crawl-2", "Wrong B"));
    const repeat = await syncCrawlIssuesToActions("site-a");
    expect(repeat.created).toBe(0);
    expect(mocks.actions).toHaveLength(4);
    const aeo = mocks.actions.find(a => a.kind === "fix_business_identity_jsonld");
    expect(aeo?.dedupeKey).toBe(`gap:identity-jsonld:${url}`);
    expect((aeo?.evidence as { verifier?: { check?: string } }).verifier?.check).toContain("valid identity JSON-LD");
    const business = mocks.actions.find(a => a.kind === "fix_technical_issue" && (a.evidence as { verifier?: { type?: string } }).verifier?.type === "business_identity_comparison");
    expect((business?.evidence as { examples: Array<{ url: string }> }).examples[0].url).toBe(url);
    mocks.crawlId = "crawl-3"; mocks.issues.set("crawl-3", []);
    await syncCrawlIssuesToActions("site-a");
    expect(mocks.actions.every(a => a.status === "FULFILLED")).toBe(true);
  });
  it("keeps a persisting gap open with current evidence and isolates projects", async () => {
    mocks.issues.set("crawl-1", findings("crawl-1", "Wrong A"));
    await syncCrawlIssuesToActions("site-a");
    mocks.crawlId = "crawl-2"; mocks.issues.set("crawl-2", findings("crawl-2", "Wrong B"));
    await syncCrawlIssuesToActions("site-a");
    expect(mocks.actions).toHaveLength(4);
    expect(mocks.actions.every(a => a.status === "PROPOSED")).toBe(true);
    expect(JSON.stringify(mocks.actions.map(a => a.evidence))).toContain("Wrong B");
    mocks.sites.set("site-b", { domain: "example.com", projectId: "project-b" });
    mocks.crawlId = "crawl-b"; mocks.issues.set("crawl-b", findings("crawl-b", "Wrong A"));
    await syncCrawlIssuesToActions("site-b");
    expect(mocks.actions).toHaveLength(8);
  });
});
