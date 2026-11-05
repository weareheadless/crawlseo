import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import { runMonthlyBundle, type BundleDeps } from "@/lib/research/monthly-bundle";
import { saveResearchSources } from "@/lib/research/service";

const enabled = process.env.RUN_MONTHLY_BUNDLE_DB_TESTS === "1";
const fixtureDatabase = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return (
      url.protocol.startsWith("postgres") &&
      new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname) &&
      url.pathname.slice(1).endsWith("_validation")
    );
  } catch {
    return false;
  }
})();
if (enabled && !fixtureDatabase) {
  throw new Error("RUN_MONTHLY_BUNDLE_DB_TESTS requires the disposable PostgreSQL fixture DATABASE_URL");
}
const dbDescribe = enabled ? describe : describe.skip;

const ownedWorkspaces = new Set<string>();
const ownedRawResponses = new Set<string>();

function depsFor(run: { projectId: string; siteId: string }): BundleDeps {
  const observedAt = new Date("2026-11-05T10:00:00Z");

  const storeRaw = async (endpoint: string, costMicros: number) => {
    const raw = await db.rawProviderResponse.create({
      data: {
        provider: "dataforseo",
        product: endpoint.includes("serp") ? "serp" : "dataforseo_labs",
        endpoint,
        providerTaskId: randomUUID(),
        locale: "fr:2250",
        requestedAt: observedAt,
        deliveredAt: observedAt,
        costMicros: BigInt(costMicros),
        status: "succeeded",
        payload: { fixture: true } as never,
      },
      select: { id: true },
    });
    ownedRawResponses.add(raw.id);
    return raw.id;
  };

  return {
    collectKeywordMetrics: async (_db, input) => {
      const rawResponseId = await storeRaw("keyword_overview/live", input.queries.length * 1_400);
      const evidence = [];
      for (const query of input.queries) {
        const stored = await storeEvidenceRecord(db, {
          projectId: run.projectId,
          siteId: run.siteId,
          kind: "keyword_metrics",
          observedAt,
          producer: "dataforseo",
          rawResponseId,
          dimensions: { query, locale: "fr:2250", product: "keyword_overview" },
          metrics: {
            "provider:volume": { value: 120, unit: "searches/month", source: "provider" },
          },
        });
        evidence.push({
          id: stored.id,
          kind: "keyword_metrics",
          observedAt,
          dimensions: { query },
          metrics: {},
        });
      }
      return { evidence, spentMicros: input.queries.length * 1_400 };
    },
    collectSerpSnapshots: async (_db, input) => {
      const rawResponseId = await storeRaw("google/organic/live/advanced", 2_000);
      const evidence = [];
      for (const query of input.queries) {
        const stored = await storeEvidenceRecord(db, {
          projectId: run.projectId,
          siteId: run.siteId,
          kind: "serp_snapshot",
          observedAt,
          producer: "dataforseo",
          rawResponseId,
          dimensions: { query, device: "desktop", locale: "fr:2250", competitorCovered: "false" },
          metrics: {
            "provider:organicResults": { value: 10, unit: "count", source: "provider" },
          },
        });
        evidence.push({
          id: stored.id,
          kind: "serp_snapshot",
          observedAt,
          dimensions: { query },
          metrics: {},
        });
      }
      return { evidence, spentMicros: input.queries.length * 2_000 };
    },
    collectAiOverviews: async (_db, input) => {
      const rawResponseId = await storeRaw("serp/google/organic/live/advanced", 2_000);
      const evidence = [];
      for (const question of input.questions) {
        const stored = await storeEvidenceRecord(db, {
          projectId: run.projectId,
          siteId: run.siteId,
          kind: "ai_visibility_observation",
          observedAt,
          producer: "dataforseo",
          rawResponseId,
          dimensions: {
            question,
            surface: "google_ai_overview",
            model: null,
            locale: "fr:2250",
            dataset: "fixture-task",
            rawExportReference: "dataforseo:fixture-task",
            answered: "true",
            device: "desktop",
          },
          metrics: {
            "provider:citedCount": { value: 1, unit: "count", source: "provider" },
            "provider:samples": { value: 1, unit: "count", source: "provider" },
          },
        });
        evidence.push({
          id: stored.id,
          kind: "ai_visibility_observation",
          observedAt,
          dimensions: { question },
          metrics: {},
        });
      }
      return { evidence, spentMicros: input.questions.length * 2_000, absent: [], failed: [] };
    },
    backfill: async () => {
      await storeEvidenceRecord(db, {
        projectId: run.projectId,
        siteId: run.siteId,
        kind: "onpage_crawl",
        observedAt,
        producer: "crawler",
        dimensions: { url: "https://fixture.example/", issueType: "MISSING_TITLE" },
        metrics: { "first_party:issueCount": { value: 1, unit: "count", source: "first_party" } },
      });
      await storeEvidenceRecord(db, {
        projectId: run.projectId,
        siteId: run.siteId,
        kind: "gsc_page",
        observedAt,
        producer: "search_console",
        dimensions: { url: "https://fixture.example/", windowDays: 28 },
        metrics: { "first_party:impressions": { value: 10, unit: "count", source: "first_party" } },
      });
      return {
        projectId: run.projectId,
        crawlEvidence: 1,
        rankEvidence: 0,
        pageEvidence: 1,
        window: { start: "2026-11-01", end: "2026-11-28", days: 28 },
        skipped: [],
      };
    },
    bridgeKnowledge: async () => {
      await storeEvidenceRecord(db, {
        projectId: run.projectId,
        siteId: run.siteId,
        kind: "knowledge_fact",
        observedAt,
        producer: "business_knowledge",
        dimensions: { field: "businessName", question: "businessName", value: "Fixture Atelier" },
        metrics: {},
      });
      return { document: true, revision: 1, stored: 1, skipped: [] };
    },
    fetchNews: async () => [
      {
        provider: "google_news_rss",
        url: "https://news.example/fixture-news",
        title: "Fixture news",
        contentHash: "fixture-news-hash",
      },
    ],
    saveNews: saveResearchSources,
    resolveLocale: async () => ({ language: "fr", languageCode: "fr", country: "FR", locationCode: 2250 }),
    hasCredentials: async () => true,
  };
}

dbDescribe("monthly bundle on disposable PostgreSQL", () => {
  beforeAll(async () => {
    await db.$connect();
  });
  afterEach(async () => {
    if (ownedRawResponses.size > 0) {
      await db.rawProviderResponse.deleteMany({ where: { id: { in: [...ownedRawResponses] } } });
      ownedRawResponses.clear();
    }
    if (ownedWorkspaces.size > 0) {
      await db.workspace.deleteMany({ where: { id: { in: [...ownedWorkspaces] } } });
      ownedWorkspaces.clear();
    }
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("stores one bundle, records the receipt, and does not pay twice", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const workspace = await db.workspace.create({
      data: { externalOrganizationId: `monthly-bundle:${suffix}`, name: `Monthly bundle ${suffix}` },
    });
    ownedWorkspaces.add(workspace.id);
    const project = await db.project.create({
      data: {
        workspaceId: workspace.id,
        externalProjectId: `monthly-bundle:${suffix}`,
        name: "Monthly bundle fixture",
        monthlyResearchAllowanceMicros: BigInt(1_000_000),
        maxResearchOperationMicros: BigInt(100_000),
        researchBudgetCurrency: "USD",
        researchBudgetTimeZone: "UTC",
      },
    });
    const site = await db.site.create({
      data: { projectId: project.id, domain: `bundle-${suffix}.example` },
    });
    await db.siteProfile.create({
      data: {
        siteId: site.id,
        projectId: project.id,
        language: "fr",
        topics: ["luminaires artisanaux"],
        audience: "Particuliers",
        constraints: { market: "France" },
      },
    });
    // The bundle selects from stored Search Console evidence.
    for (let index = 0; index < 40; index += 1) {
      await storeEvidenceRecord(db, {
        projectId: project.id,
        siteId: site.id,
        kind: "keyword_rank",
        observedAt: new Date("2026-11-04T00:00:00Z"),
        producer: "search_console",
        dimensions: { query: `requete ${index + 1}`, windowRole: "current", windowDays: 28 },
        metrics: {
          "first_party:impressions": { value: 500 - index, unit: "count", source: "first_party" },
          "first_party:clicks": { value: 10, unit: "count", source: "first_party" },
        },
      });
    }
    await storeEvidenceRecord(db, {
      projectId: project.id,
      siteId: site.id,
      kind: "question_coverage",
      observedAt: new Date("2026-11-04T00:00:00Z"),
      producer: "research",
      dimensions: { question: "comment réparer un abat jour", intent: "how" },
      metrics: {},
    });

    const deps = depsFor({ projectId: project.id, siteId: site.id });
    const first = await runMonthlyBundle(
      db,
      { siteId: site.id, month: "2026-11", mode: "execute", approval: "fixture-approval" },
      deps
    );

    expect(first.status).toBe("completed");
    expect(first.paidCalls).toBeGreaterThan(0);
    const run = await db.researchRun.findFirstOrThrow({
      where: { siteId: site.id, idempotencyKey: `monthly:${site.id}:2026-11:bundle` },
    });
    expect(run.status).toBe("COMPLETED");
    expect(run.costMicros).toBeGreaterThan(0);
    expect((run.brief as { approvalReference?: string }).approvalReference).toBe("fixture-approval");
    expect((run.report as { bundle?: { month?: string } }).bundle?.month).toBe("2026-11");

    const byKind = await db.evidenceRecord.groupBy({
      by: ["kind"],
      where: { projectId: project.id, siteId: site.id },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(byKind.map((row) => [row.kind, row._count._all]));
    expect(counts.keyword_metrics).toBe(30);
    expect(counts.serp_snapshot).toBe(10);
    expect(counts.ai_visibility_observation).toBe(12);
    expect(counts.onpage_crawl).toBe(1);
    expect(counts.gsc_page).toBe(1);
    expect(counts.knowledge_fact).toBe(1);
    expect(await db.researchSource.count({ where: { runId: run.id } })).toBe(1);

    const evidenceBefore = await db.evidenceRecord.count({ where: { projectId: project.id } });
    const rawBefore = await db.rawProviderResponse.count();
    const second = await runMonthlyBundle(
      db,
      { siteId: site.id, month: "2026-11", mode: "execute", approval: "fixture-approval" },
      deps
    );
    expect(second.status).toBe("existing");
    expect(second.paidCalls).toBe(0);
    expect(await db.researchRun.count({ where: { siteId: site.id } })).toBe(1);
    expect(await db.evidenceRecord.count({ where: { projectId: project.id } })).toBe(evidenceBefore);
    expect(await db.rawProviderResponse.count()).toBe(rawBefore);
  }, 120_000);
});
