import { buildNewsQueriesForSite } from "@/lib/research/monthly-bundle";
import { describe, expect, it } from "vitest";

import {

  isoWeekKey,
  runWeeklyRefresh,
  type WeeklyDeps,
} from "@/lib/research/weekly-refresh";

const now = new Date("2026-11-05T12:00:00Z");

function recentNews(daysAgo = 5) {
  return {
    provider: "google_news_rss",
    title: "Un atelier de tapisserie ouvre en Normandie",
    url: "https://news.example/atelier",
    publishedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
    excerpt: "Une nouvelle exposition.",
    contentHash: "hash-1",
  };
}

function mapReport() {
  return {
    map: {
      siteId: "site-1",
      projectId: "proj-1",
      domain: "atelier-harmonie.example",
      month: "2026-11",
      generatedAt: now.toISOString(),
      locale: { language: "fr", country: "FR" },
      business: { name: "Atelier", services: [], location: null, serviceArea: [], audience: null, differentiators: [] },
      clusters: [{
        slug: "local-normandie",
        name: "Local",
        topicSummary: "",
        intent: "local",
        relevance: "high",
        rationale: "",
        actionHint: "",
        confidence: 0.8,
        metrics: { queries: 1, impressions: 1, clicks: 0, volume: 0, difficulty: null, position: null, aeoQuestions: 0, aeoCited: 0 },
        queries: [],
        pages: [],
        coverage: "strong",
        gaps: [],
      }],
      unmapped: [],
      news: [],
      ai: { available: false, model: null, summary: null, review: null, priorityTopics: [], weakTopics: [], error: null },
      counts: { queries: 0, clusteredQueries: 0, unmappedQueries: 0, pages: 0, news: 0 },
    },
  };
}

function makeDb() {
  const state = {
    created: 0,
    updated: 0,
    runs: [] as Array<Record<string, unknown>>,
    expired: [] as Array<Record<string, unknown>>,
    parked: [] as string[],
  };
  const db = {
    site: {
      findUnique: async () => ({ id: "site-1", domain: "atelier-harmonie.example", projectId: "proj-1", retiredAt: null }),
    },
    siteProfile: {
      findUnique: async () => ({ language: "fr", topics: [], audience: null, constraints: { market: "France" } }),
    },
    businessKnowledgeDocument: {
      findUnique: async () => ({
        revision: 1,
        acceptedRevision: 1,
        revisions: [{
          revision: 1,
          fields: {
            businessName: { value: "Atelier de l'harmonie" },
            services: { value: ["Restauration de siège", "Restauration d'abat-jour"] },
            location: { value: "Saint-Pierre-en-Port, France" },
            serviceArea: { value: ["Normandie"] },
          },
        }],
      }),
    },
    researchRun: {
      findFirst: async ({ where }: { where: { idempotencyKey?: string } }) => {
        if (where.idempotencyKey?.startsWith("topic-map:")) return { id: "topic-run", report: mapReport() };
        if (where.idempotencyKey?.startsWith("weekly:")) return state.runs[0] ?? null;
        return null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.created += 1;
        const run = { id: "weekly-run-1", ...data };
        state.runs.push(run);
        return run;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        state.updated += 1;
        const run = state.runs.find((entry) => entry.id === where.id);
        if (run) Object.assign(run, data);
        return run ?? { id: where.id, ...data };
      },
    },
    demandMapCluster: {
      findMany: async () => [{ id: "cluster-1", slug: "local-normandie" }],
    },
    opportunity: {
      findMany: async () => state.expired,
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        state.parked.push(...where.id.in);
        return { count: where.id.in.length };
      },
    },
    evidenceRecord: {
      findMany: async ({ where }: { where: { kind?: string } }) => {
        if (where.kind === "knowledge_fact") return [{ id: "knowledge-1" }, { id: "knowledge-2" }];
        if (where.kind === "keyword_universe_membership") return [{ id: "local-1" }];
        return [{ id: "knowledge-1" }, { id: "knowledge-2" }, { id: "local-1" }];
      },
    },
  };
  return { db, state };
}

function makeDeps(overrides: Partial<WeeklyDeps> = {}): WeeklyDeps {
  return {
    backfill: async () => ({
      projectId: "proj-1",
      crawlEvidence: 10,
      rankEvidence: 20,
      pageEvidence: 5,
      window: { start: "2026-10-01", end: "2026-10-28", days: 28 },
      skipped: [],
    }),
    bridgeKnowledge: async () => ({ document: true, revision: 1, stored: 2, skipped: [] }),
    bridgeCoverage: async () => ({ document: true, questions: 3, stored: 3, keywords: 0, omitted: 0 }),
    fetchNews: async () => [recentNews()],
    saveNews: async () => [{ id: "source-1" }],
    storeProposals: async () => ({ stored: [{ id: "opp-1", dedupKey: "phase5:timely" }], dropped: [], reproposedClosed: [] }),
    // Test double for the drafting call: it keeps the 21-day rule the real
    // call is given, so the weekly flow is exercised without a model.
    draftTimely: async (input) => {
      const fresh = input.news.filter(
        (item) => item.publishedAt && input.now.getTime() - Date.parse(item.publishedAt) <= 21 * 86_400_000
      );
      if (fresh.length === 0) {
        return { proposals: [], errors: ["no news source within 21 days"], rejected: [], truncations: [], summary: null, model: "test-model" };
      }
      return {
        proposals: [
          {
            dedupKey: "phase3:timely:abc",
            lane: "timely" as const,
            kind: "article" as const,
            title: "Réagir à la presse locale",
            summary: "Local press is current.",
            whyNow: `Published ${fresh[0].publishedAt?.slice(0, 10)}.`,
            evidenceRefs: ["knowledge-1"],
            target: { url: "/blog", newAsset: true, section: "news" },
            action: "Write a dated note.",
            expectedOutcome: "A dated, linkable story.",
            effort: "small" as const,
            confidence: "low" as const,
            confidenceReason: "Local query demand is thin.",
            expiresAt: new Date(input.now.getTime() + 20 * 86_400_000).toISOString(),
            topicSlug: "local-normandie",
            sources: [{ title: fresh[0].title, url: fresh[0].url, publishedAt: fresh[0].publishedAt }],
            critique: null,
          },
        ],
        errors: [],
        rejected: [],
        truncations: [],
        summary: "One current local story.",
        model: "test-model",
      };
    },
    ...overrides,
  };
}

describe("weekly refresh", () => {
  it("computes the ISO week key", () => {
    expect(isoWeekKey(now)).toBe("2026-W45");
  });

  it("builds business and event news queries", () => {
    const queries = buildNewsQueriesForSite({
      businessName: "Atelier de l'harmonie",
      services: ["Restauration de siège", "Restauration d'abat-jour"],
      location: "Saint-Pierre-en-Port, France",
      serviceArea: ["Normandie"],
      domain: "atelier-harmonie.example",
      taxonomyQueries: ["Normandie salon artisanat 2026", "Normandie portes ouvertes atelier 2026"],
    });
    expect(queries[0]).toContain("Atelier de l'harmonie");
    // Tenant-specific event searches now come from the approved taxonomy.
    expect(queries.join(" ")).toContain("salon artisanat 2026");
    expect(queries.join(" ")).toContain("portes ouvertes atelier 2026");
    expect(new Set(queries).size).toBe(queries.length);
  });

  it("stores the timely proposal the drafting call returns", async () => {
    const { db } = makeDb();
    const drafted = {
      proposals: [
        {
          dedupKey: "phase3:timely:abc",
          lane: "timely" as const,
          kind: "article" as const,
          title: "Réagir à la presse locale",
          summary: "Local press is current.",
          whyNow: "Published 2026-10-31.",
          evidenceRefs: ["knowledge-1"],
          target: { url: "/blog", newAsset: true, section: "news" },
          action: "Write a dated note.",
          expectedOutcome: "A dated, linkable story.",
          effort: "small" as const,
          confidence: "low" as const,
          confidenceReason: "Local query demand is thin.",
          expiresAt: new Date(now.getTime() + 20 * 86_400_000).toISOString(),
          topicSlug: "local-normandie",
          sources: [{ title: recentNews().title, url: recentNews().url, publishedAt: recentNews().publishedAt }],
          critique: null,
        },
      ],
      errors: [],
      rejected: [],
      truncations: [],
      summary: "One current local story.",
      model: "test-model",
    };
    const result = await runWeeklyRefresh(
      db as never,
      { siteId: "site-1", mode: "execute", now, approval: "test" },
      makeDeps({ draftTimely: async () => drafted })
    );
    expect(result.timely.proposals).toHaveLength(1);
    expect(result.timely.stored).toBe(1);
  });

  it("records why no timely proposal was drafted", async () => {
    const { db } = makeDb();
    const result = await runWeeklyRefresh(
      db as never,
      { siteId: "site-1", mode: "execute", now, approval: "test" },
      makeDeps({ draftTimely: async () => ({ proposals: [], errors: ["no news source within 21 days"], rejected: [], truncations: [], summary: null, model: "test-model" }) })
    );
    expect(result.timely.proposals).toHaveLength(0);
    expect(result.timely.reason).toMatch(/21 days/);
  });

  it("dry run makes no writes", async () => {
    const { db, state } = makeDb();
    const result = await runWeeklyRefresh(db as never, { siteId: "site-1", mode: "dry-run", now }, makeDeps());
    expect(result.status).toBe("planned");
    expect(state.created).toBe(0);
    expect(state.updated).toBe(0);
    expect(result.queries.length).toBeGreaterThan(0);
  });

  it("refreshes evidence, stores news and a current timely proposal", async () => {
    const { db, state } = makeDb();
    let storedProposals = 0;
    const result = await runWeeklyRefresh(
      db as never,
      { siteId: "site-1", mode: "execute", approval: "weekly-test", now },
      makeDeps({
        storeProposals: async (_db, input) => {
          storedProposals = input.proposals.length;
          return { stored: input.proposals.map((proposal) => ({ id: "opp-1", dedupKey: proposal.dedupKey })), dropped: [], reproposedClosed: [] };
        },
      })
    );
    expect(result.status).toBe("completed");
    expect(result.runId).toBe("weekly-run-1");
    expect(result.evidence.crawl).toBe(10);
    expect(result.news.stored).toBe(1);
    expect(result.timely.proposals).toHaveLength(1);
    expect(result.timely.stored).toBe(1);
    expect(storedProposals).toBe(1);
    expect(state.created).toBe(1);
    expect(state.runs[0]).toMatchObject({ status: "COMPLETED" });
  });

  it("records an empty timely lane when the news is old", async () => {
    const { db } = makeDb();
    const result = await runWeeklyRefresh(
      db as never,
      { siteId: "site-1", mode: "execute", now },
      makeDeps({ fetchNews: async () => [recentNews(25)] })
    );
    expect(result.status).toBe("completed");
    expect(result.timely.proposals).toHaveLength(0);
    expect(result.timely.stored).toBe(0);
    expect(result.timely.reason).toMatch(/21 days/);
  });

  it("parks an expired timely item instead of leaving it on the board", async () => {
    const { db, state } = makeDb();
    state.expired.push({
      id: "opp-old",
      recommendationDecision: {
        schemaVersion: "phase3-v1",
        source: "phase3-topic-map",
        readiness: "actionable",
        lane: "timely",
        kind: "article",
        title: "Old timely item",
        summary: "",
        whyNow: "",
        evidenceRefs: [],
        target: { url: "/blog", newAsset: true, section: null },
        action: "",
        expectedOutcome: "",
        effort: "small",
        confidence: "low",
        expiresAt: "2020-01-01T00:00:00.000Z",
        topicSlug: "local-normandie",
        sources: [],
        critique: null,
      },
    });
    const result = await runWeeklyRefresh(db as never, { siteId: "site-1", mode: "execute", now }, makeDeps());
    expect(result.timely.expired).toBe(1);
    expect(state.parked).toContain("opp-old");
  });

  it("returns an existing weekly run without redoing the work", async () => {
    const { db, state } = makeDb();
    state.runs.push({ id: "weekly-run-1", status: "COMPLETED", report: { evidence: { crawl: 1, gsc: 2, knowledge: 3, questionCoverage: 4 }, news: { fetched: 1, stored: 1, items: [] }, timely: { proposals: [], stored: 0, dropped: [], reason: "old" } } });
    let backfills = 0;
    const result = await runWeeklyRefresh(
      db as never,
      { siteId: "site-1", mode: "execute", now },
      makeDeps({ backfill: async () => { backfills += 1; return { projectId: "proj-1", crawlEvidence: 0, rankEvidence: 0, pageEvidence: 0, window: null, skipped: [] }; } })
    );
    expect(result.status).toBe("existing");
    expect(backfills).toBe(0);
    expect(result.evidence.crawl).toBe(1);
  });
});
