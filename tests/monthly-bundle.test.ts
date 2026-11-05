import { describe, expect, it } from "vitest";

import {
  BundleApprovalError,
  BundleCapError,
  BundleCredentialsError,
  buildNewsQueries,
  planPaidCalls,
  rankQueries,
  resolveBundleCaps,
  runMonthlyBundle,
  selectAeoQuestions,
  withinBundleCap,
  type BundleDeps,
} from "@/lib/research/monthly-bundle";

type RunRow = {
  id: string;
  siteId: string;
  projectId: string;
  status: string;
  idempotencyKey: string;
  title: string;
  brief: unknown;
  report: unknown;
  costMicros: number;
  sourceCount: number;
  findingCount: number;
  actionCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  errorCode: string | null;
};

type State = {
  runs: RunRow[];
  evidence: Array<{ id: string; kind: string; observedAt: Date; dimensions: unknown; metrics: unknown }>;
  reservations: Array<{ status: string; amountMicros: bigint; actualCostMicros: bigint | null }>;
  creates: number;
};

function makeState(): State {
  return { runs: [], evidence: [], reservations: [], creates: 0 };
}

function makeDb(state: State, options: { coverage?: unknown[] } = {}) {
  const site = {
    id: "site-1",
    domain: "atelier.example",
    projectId: "proj-1",
    retiredAt: null,
  };
  const profile = {
    language: "fr",
    topics: ["luminaires artisanaux"],
    audience: "Particuliers",
    constraints: { market: "France, Normandie" },
  };
  const knowledge = {
    revision: 1,
    acceptedRevision: 1,
    revisions: [
      {
        revision: 1,
        createdAt: new Date("2026-11-01T00:00:00Z"),
        fields: {
          businessName: { value: "Atelier Test" },
          location: { value: "Saint-Pierre-en-Port, France" },
          services: { value: ["Restauration de siège", "Restauration d'abat-jour"] },
        },
      },
    ],
  };
  const ranks = Array.from({ length: 40 }, (_, index) => ({
    dimensions: { query: `query ${index + 1}`, windowRole: "current" },
    metrics: { "first_party:impressions": { value: 1_000 - index * 10 } },
  }));
  const coverage = options.coverage ?? [
    { dimensions: { question: "How does Atelier Test compare with other providers?", intent: "comparison" } },
    { dimensions: { question: "comment réparer un abat jour", intent: "how" } },
  ];

  return {
    site: {
      findUnique: async () => site,
    },
    siteProfile: {
      findUnique: async () => profile,
    },
    businessKnowledgeDocument: {
      findUnique: async () => knowledge,
    },
    evidenceRecord: {
      findMany: async (args: { where: { kind: string; observedAt?: { gte?: Date } } }) => {
        const { kind, observedAt } = args.where;
        if (kind === "keyword_rank") return ranks;
        if (kind === "question_coverage") return coverage;
        return state.evidence.filter(
          (row) =>
            row.kind === kind &&
            (!observedAt?.gte || row.observedAt.getTime() >= observedAt.gte.getTime())
        );
      },
      groupBy: async () => {
        const counts = new Map<string, number>();
        for (const row of state.evidence) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
        return [...counts.entries()].map(([kind, count]) => ({ kind, _count: { _all: count } }));
      },
    },
    project: {
      findUnique: async () => ({
        monthlyResearchAllowanceMicros: BigInt(1_000_000),
        researchBudgetCurrency: "USD",
        researchBudgetTimeZone: "UTC",
      }),
    },
    researchBudgetReservation: {
      findMany: async () => state.reservations,
    },
    projectApiKeyGrant: {
      findFirst: async () => ({
        apiKeyId: "key-1",
        providerCredentialId: null,
        providerCredential: null,
      }),
    },
    researchRun: {
      findFirst: async (args: { where: { id?: string; siteId?: string; idempotencyKey?: string } }) => {
        if (args.where.id) return state.runs.find((run) => run.id === args.where.id) ?? null;
        return (
          state.runs.find(
            (run) =>
              run.siteId === args.where.siteId && run.idempotencyKey === args.where.idempotencyKey
          ) ?? null
        );
      },
      create: async (args: { data: Omit<RunRow, "id" | "createdAt" | "updatedAt" | "sourceCount" | "findingCount" | "actionCount" | "completedAt" | "costMicros" | "errorCode" | "report"> }) => {
        const run: RunRow = {
          id: `run-${state.runs.length + 1}`,
          createdAt: new Date("2026-11-05T10:00:00Z"),
          updatedAt: new Date("2026-11-05T10:00:00Z"),
          sourceCount: 0,
          findingCount: 0,
          actionCount: 0,
          completedAt: null,
          costMicros: 0,
          errorCode: null,
          report: null,
          ...args.data,
        };
        state.runs.push(run);
        state.creates += 1;
        return run;
      },
      update: async (args: { where: { id: string }; data: Partial<RunRow> }) => {
        const run = state.runs.find((row) => row.id === args.where.id);
        if (!run) throw new Error("run not found");
        Object.assign(run, args.data);
        return run;
      },
    },
  };
}

function makeDeps(state: State, overrides: Partial<BundleDeps> = {}): BundleDeps {
  const calls = { keyword: 0, serp: 0, aeo: 0, news: 0, save: 0 };
  const deps: BundleDeps = {
    collectKeywordMetrics: async (_db, input) => {
      calls.keyword += 1;
      return {
        evidence: input.queries.map((query) => ({
          id: `kw-${query}`,
          kind: "keyword_metrics",
          observedAt: new Date("2026-11-05T10:00:00Z"),
          dimensions: { query },
          metrics: {},
        })),
        spentMicros: input.queries.length * 1_400,
      };
    },
    collectSerpSnapshots: async (_db, input) => {
      calls.serp += 1;
      return {
        evidence: input.queries.map((query) => ({
          id: `serp-${query}`,
          kind: "serp_snapshot",
          observedAt: new Date("2026-11-05T10:00:00Z"),
          dimensions: { query },
          metrics: {},
        })),
        spentMicros: input.queries.length * 2_000,
      };
    },
    collectAiOverviews: async (_db, input) => {
      calls.aeo += 1;
      return {
        evidence: input.questions.map((question) => ({
          id: `aeo-${question}`,
          kind: "ai_visibility_observation",
          observedAt: new Date("2026-11-05T10:00:00Z"),
          dimensions: { question },
          metrics: {},
        })),
        spentMicros: input.questions.length * 2_000,
        absent: [],
        failed: [],
      };
    },
    backfill: async () => ({
      projectId: "proj-1",
      crawlEvidence: 2,
      rankEvidence: 3,
      pageEvidence: 1,
      window: { start: "2026-11-01", end: "2026-11-28", days: 28 },
      skipped: [],
    }),
    bridgeKnowledge: async () => ({ document: true, revision: 1, stored: 2, skipped: [] }),
    fetchNews: async () => {
      calls.news += 1;
      return [
        {
          provider: "google_news_rss",
          url: "https://example.com/news/1",
          title: "Atelier news",
          contentHash: "hash-1",
        },
      ];
    },
    saveNews: async (_runId, sources) => {
      calls.save += 1;
      return sources.map((_source, index) => ({ id: `news-${index + 1}` }));
    },
    resolveLocale: async () => ({
      language: "fr",
      languageCode: "fr",
      country: "FR",
      locationCode: 2250,
    }),
    hasCredentials: async () => true,
  };
  return Object.assign(deps, overrides, { calls });
}

function seedCompletedRun(state: State, month = "2026-11") {
  state.runs.push({
    id: "run-existing",
    siteId: "site-1",
    projectId: "proj-1",
    status: "COMPLETED",
    idempotencyKey: `monthly:site-1:${month}:bundle`,
    title: "Monthly evidence bundle",
    brief: { month },
    report: { bundle: { month }, counts: { evidenceByKind: { keyword_metrics: 3 } } },
    costMicros: 12_345,
    sourceCount: 4,
    findingCount: 0,
    actionCount: 0,
    startedAt: new Date("2026-11-01T10:00:00Z"),
    completedAt: new Date("2026-11-01T10:05:00Z"),
    createdAt: new Date("2026-11-01T10:00:00Z"),
    updatedAt: new Date("2026-11-01T10:05:00Z"),
    errorCode: null,
  });
}

describe("monthly bundle selection", () => {
  it("ranks queries by first-party impressions and removes duplicates", () => {
    const queries = rankQueries([
      { dimensions: { query: "b", windowRole: "current" }, metrics: { "first_party:impressions": { value: 10 } } },
      { dimensions: { query: "a", windowRole: "current" }, metrics: { "first_party:impressions": { value: 30 } } },
      { dimensions: { query: "B", windowRole: "current" }, metrics: { "first_party:impressions": { value: 20 } } },
      { dimensions: { query: "old", windowRole: "previous" }, metrics: { "first_party:impressions": { value: 999 } } },
    ]);
    expect(queries).toEqual(["a", "b"]);
  });

  it("does not use English question templates for a French AEO run", () => {
    const questions = selectAeoQuestions(
      [
        "How does Atelier de l'harmonie compare with other providers?",
        "comment réparer un abat jour",
      ],
      ["luminaire artisanal", "comment restaurer un abat jour"],
      3,
      "fr"
    );
    expect(questions).toEqual([
      "comment réparer un abat jour",
      "comment restaurer un abat jour",
      "luminaire artisanal",
    ]);
  });

  it("builds free news queries from business knowledge", () => {
    const queries = buildNewsQueries({
      businessName: "Atelier de l'harmonie",
      services: ["Restauration de siège", "Restauration d'abat-jour"],
      location: "Saint-Pierre-en-Port, France",
      domain: "atelier-harmonie.com",
    });
    expect(queries).toEqual([
      '"Atelier de l\'harmonie"',
      '"Restauration de siège" Saint-Pierre-en-Port, France',
      '"Restauration d\'abat-jour" Saint-Pierre-en-Port, France',
      '"Saint-Pierre-en-Port, France" artisanat',
    ]);
  });

  it("estimates one keyword batch per 20 queries", () => {
    const calls = planPaidCalls({
      keywordQueries: Array.from({ length: 30 }, (_, index) => `q${index}`),
      serpQueries: ["a", "b"],
      aeoQuestions: ["c"],
    });
    expect(calls.filter((call) => call.section === "keyword_metrics")).toHaveLength(2);
    expect(calls.filter((call) => call.section === "serp_snapshots")).toHaveLength(2);
    expect(calls.filter((call) => call.section === "aeo_geo")).toHaveLength(1);
  });

  it("refuses a cap outside the contract", () => {
    expect(() => resolveBundleCaps({ keywordQueries: 41 })).toThrow(/cannot exceed 40/);
    expect(() => resolveBundleCaps({ serpQueries: 11 })).toThrow(/cannot exceed 10/);
    expect(() => resolveBundleCaps({ aeoQuestions: 21 })).toThrow(/cannot exceed 20/);
  });

  it("checks the cap before a call", () => {
    expect(withinBundleCap(90_000, 9_000, 100_000)).toBe(true);
    expect(withinBundleCap(95_000, 9_000, 100_000)).toBe(false);
  });
});

describe("monthly bundle run", () => {
  it("dry run selects the bundle and makes no paid calls", async () => {
    const state = makeState();
    const db = makeDb(state);
    const deps = makeDeps(state);

    const result = await runMonthlyBundle(
      db as never,
      { siteId: "site-1", month: "2026-11", mode: "dry-run" },
      deps
    );

    expect(result.status).toBe("planned");
    expect(result.plan.selected.keywordQueries).toHaveLength(30);
    expect(result.plan.selected.serpQueries).toHaveLength(10);
    expect(result.plan.selected.aeoQuestions).toHaveLength(12);
    expect(result.plan.selected.newsQueries).toHaveLength(4);
    expect(result.plan.estimatedMicros).toBeGreaterThan(0);
    expect(result.paidCalls).toBe(0);
    expect(state.creates).toBe(0);
    expect((deps as unknown as { calls: Record<string, number> }).calls).toEqual({
      keyword: 0,
      serp: 0,
      aeo: 0,
      news: 0,
      save: 0,
    });
  });

  it("stores one bundle and returns the receipt on the second execute", async () => {
    const state = makeState();
    const db = makeDb(state);
    const deps = makeDeps(state);

    const first = await runMonthlyBundle(
      db as never,
      { siteId: "site-1", month: "2026-11", mode: "execute", approval: "owner-2026-11" },
      deps
    );

    expect(first.status).toBe("completed");
    expect(first.exitCode).toBe(0);
    expect(first.paidCalls).toBe(2 + 10 + 12);
    expect(first.totalCostMicros).toBeGreaterThan(0);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      status: "COMPLETED",
      idempotencyKey: "monthly:site-1:2026-11:bundle",
    });
    const report = state.runs[0].report as {
      bundle: { approvalReference: string; actualMicros: number };
      sections: Array<{ name: string; status: string; stored: number }>;
    };
    expect(report.bundle.approvalReference).toBe("owner-2026-11");
    expect(report.bundle.actualMicros).toBe(first.totalCostMicros);
    expect(report.sections.map((section) => section.name)).toEqual([
      "business_knowledge",
      "crawl",
      "gsc",
      "keyword_metrics",
      "serp_snapshots",
      "aeo_geo",
      "news_events",
    ]);

    const callsBefore = { ...(deps as unknown as { calls: Record<string, number> }).calls };
    const second = await runMonthlyBundle(
      db as never,
      { siteId: "site-1", month: "2026-11", mode: "execute", approval: "owner-2026-11" },
      deps
    );

    expect(second.status).toBe("existing");
    expect(second.paidCalls).toBe(0);
    expect(second.receipt?.runId).toBe(state.runs[0].id);
    expect(second.receipt?.month).toBe("2026-11");
    expect(state.runs).toHaveLength(1);
    expect((deps as unknown as { calls: Record<string, number> }).calls).toEqual(callsBefore);
  });

  it("refuses a bundle whose estimate exceeds the cap before any paid call", async () => {
    const state = makeState();
    const db = makeDb(state);
    const deps = makeDeps(state);

    await expect(
      runMonthlyBundle(
        db as never,
        {
          siteId: "site-1",
          month: "2026-11",
          mode: "execute",
          approval: "owner-2026-11",
          caps: { capMicros: 1_000 },
        },
        deps
      )
    ).rejects.toBeInstanceOf(BundleCapError);
    expect(state.runs).toHaveLength(0);
    expect((deps as unknown as { calls: Record<string, number> }).calls.keyword).toBe(0);
  });

  it("refuses execute without an approval reference", async () => {
    const state = makeState();
    const db = makeDb(state);
    const deps = makeDeps(state);

    await expect(
      runMonthlyBundle(db as never, { siteId: "site-1", month: "2026-11", mode: "execute" }, deps)
    ).rejects.toBeInstanceOf(BundleApprovalError);
    expect(state.runs).toHaveLength(0);
  });

  it("refuses execute when DataForSEO credentials are missing", async () => {
    const state = makeState();
    const db = makeDb(state);
    const deps = makeDeps(state, { hasCredentials: async () => false });

    await expect(
      runMonthlyBundle(
        db as never,
        { siteId: "site-1", month: "2026-11", mode: "execute", approval: "owner-2026-11" },
        deps
      )
    ).rejects.toBeInstanceOf(BundleCredentialsError);
    expect(state.runs).toHaveLength(0);
    expect((deps as unknown as { calls: Record<string, number> }).calls.keyword).toBe(0);
  });

  it("records a partial run when one provider section fails", async () => {
    const state = makeState();
    const db = makeDb(state);
    const deps = makeDeps(state, {
      collectSerpSnapshots: async () => {
        throw new Error("SERP provider timeout");
      },
    });

    const result = await runMonthlyBundle(
      db as never,
      { siteId: "site-1", month: "2026-11", mode: "execute", approval: "owner-2026-11" },
      deps
    );

    expect(result.status).toBe("partial");
    expect(result.exitCode).toBe(5);
    expect(result.sections.find((section) => section.name === "serp_snapshots")).toMatchObject({
      status: "failed",
      error: "SERP provider timeout",
    });
    expect(result.sections.find((section) => section.name === "keyword_metrics")?.stored).toBeGreaterThan(0);
    expect(result.sections.find((section) => section.name === "aeo_geo")?.stored).toBeGreaterThan(0);
    expect(state.runs[0].status).toBe("PARTIAL");
    expect(state.runs[0].costMicros).toBeGreaterThan(0);

    const second = await runMonthlyBundle(
      db as never,
      { siteId: "site-1", month: "2026-11", mode: "execute", approval: "owner-2026-11" },
      deps
    );
    expect(second.status).toBe("existing");
    expect(second.paidCalls).toBe(0);
    expect(state.runs).toHaveLength(1);
  });

  it("returns an existing bundle without rebuilding it", async () => {
    const state = makeState();
    seedCompletedRun(state);
    const db = makeDb(state);
    const deps = makeDeps(state);

    const result = await runMonthlyBundle(
      db as never,
      { siteId: "site-1", month: "2026-11", mode: "execute", approval: "owner-2026-11" },
      deps
    );

    expect(result.status).toBe("existing");
    expect(result.paidCalls).toBe(0);
    expect(result.plan.existingRun?.status).toBe("COMPLETED");
    expect((deps as unknown as { calls: Record<string, number> }).calls.keyword).toBe(0);
  });
});
