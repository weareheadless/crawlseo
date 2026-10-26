import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ queries: [] as string[] }));
vi.mock("@/lib/research/providers/reddit-rss", () => ({ fetchRedditRssSearch: vi.fn(async ({ query }: { query: string }) => {
  calls.queries.push(query);
  await new Promise((resolve) => setTimeout(resolve, 40));
  return [{ provider: "reddit_rss", url: "https://reddit.example/post/one", title: "One result", publishedAt: new Date().toISOString(),
    excerpt: "Fixture observation with enough content for research.", contentHash: "fixture-content-hash", metadata: { reddit_id: "post-one" } }];
}) }));
vi.mock("@/lib/research/synthesizer", () => ({ synthesizeResearch: vi.fn(async () => ({ findings: [], actions: [], model: "fixture", provider: "fixture" })) }));

import { db } from "@/lib/db";
import { runResearchRun } from "@/lib/research/runner";

const enabled = process.env.RUN_RESEARCH_SOURCE_DB_TESTS === "1";
const fixtureDatabase = (() => {
  try { const url = new URL(process.env.DATABASE_URL ?? ""); return url.protocol.startsWith("postgres") && new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname) && url.username === "codex" && url.pathname.slice(1).endsWith("_validation"); }
  catch { return false; }
})();
if (enabled && !fixtureDatabase) throw new Error("RUN_RESEARCH_SOURCE_DB_TESTS requires the disposable PostgreSQL fixture DATABASE_URL");
const dbDescribe = enabled ? describe : describe.skip;
const organizations = new Set<string>();

dbDescribe("concurrent research source reuse on disposable PostgreSQL", () => {
  beforeAll(async () => { await db.$connect(); });
  afterEach(async () => {
    if (organizations.size) await db.workspace.deleteMany({ where: { externalOrganizationId: { in: [...organizations] } } });
    organizations.clear(); calls.queries.length = 0;
  });
  afterAll(async () => { await db.$disconnect(); });

  it("serializes concurrent same-project/provider/query dispatches and persists one observation", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const externalOrganizationId = `research-fixture:${suffix}`;
    organizations.add(externalOrganizationId);
    const workspace = await db.workspace.create({ data: { externalOrganizationId, name: `Research fixture ${suffix}` } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, externalProjectId: `research:${suffix}`, name: "Research fixture" } });
    const site = await db.site.create({ data: { projectId: project.id, domain: `research-${suffix}.example` } });
    const policy = await db.researchPolicy.create({ data: { siteId: site.id, providers: ["reddit"], monthlyBudget: 20, recencyDays: 90 } });
    const makeRun = (n: number) => db.researchRun.create({ data: { siteId: site.id, projectId: project.id, title: `Concurrent ${n}`,
      brief: { language: "en", topics: ["shared query"] }, topics: ["shared query"], recencyDays: 90, policyRevision: policy.revision,
      providerSet: ["reddit"], status: "QUEUED" } });
    const [first, second] = await Promise.all([makeRun(1), makeRun(2)]);
    await Promise.all([runResearchRun(first.id), runResearchRun(second.id)]);

    const dispatchesByQuery = calls.queries.reduce<Record<string, number>>((counts, query) => { counts[query] = (counts[query] ?? 0) + 1; return counts; }, {});
    expect(Object.values(dispatchesByQuery)).toEqual([1, 1]);
    expect(await db.researchSourceIdentity.count({ where: { projectId: project.id, provider: "reddit_rss", normalizedUrl: "https://reddit.example/post/one" } })).toBe(1);
    expect(await db.researchSource.count({ where: { identity: { projectId: project.id }, contentHash: "fixture-content-hash" } })).toBe(1);
  }, 60_000);
});
