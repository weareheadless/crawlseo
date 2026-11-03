import { describe, expect, it, vi } from "vitest";

import { shadowRunKind, shadowStatus, syncArticleRunToResearchRun, type ArticleRunForShadow } from "@/lib/dataforseo/run-shadow";

const AT = new Date("2026-11-03T00:00:00.000Z");

const run = (over: Partial<ArticleRunForShadow> = {}): ArticleRunForShadow => ({
  id: "legacy-1",
  projectId: "p1",
  siteId: "s1",
  idempotencyKey: "key-1",
  ideaSummary: "Blog about freediving courses",
  seed: "freediving course",
  kind: "RELATED_KEYWORDS",
  language: "en",
  country: "MX",
  providerLanguageCode: "en",
  providerLocationCode: 2484,
  status: "COMPLETED",
  providerTaskId: "task-1",
  costMicros: 4200,
  errorCode: null,
  requestedAt: AT,
  attemptedAt: AT,
  completedAt: AT,
  parentRunId: null,
  ...over,
});

function fakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    db: {
      researchRun: {
        upsert: vi.fn(async (args: { where: { projectId_kind_idempotencyKey: { idempotencyKey: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const existing = rows.find((row) => row.idempotencyKey === args.where.projectId_kind_idempotencyKey.idempotencyKey);
          if (existing) {
            Object.assign(existing, args.update);
            return { id: existing.id };
          }
          const row = { id: `shadow-${rows.length + 1}`, ...args.create };
          rows.push(row);
          return { id: row.id };
        }),
      },
    } as never,
    rows,
  };
}

describe("DS-02 dual-write: article runs into ResearchRun", () => {
  it("maps family statuses onto the spine's without inventing states", () => {
    expect(shadowStatus("COMPLETED")).toBe("COMPLETED");
    expect(shadowStatus("FAILED")).toBe("FAILED");
    expect(shadowStatus("RUNNING")).toBe("RUNNING");
    expect(shadowStatus("REQUESTED")).toBe("QUEUED");
    expect(shadowStatus("something_new")).toBe("QUEUED");
  });

  it("tags the family so the shadow rows are identifiable", () => {
    expect(shadowRunKind()).toBe("ARTICLE_KEYWORD");
  });

  it("writes the final state with the identity the cutover needs", async () => {
    const { db, rows } = fakeDb();
    await syncArticleRunToResearchRun(db, run());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: "p1",
      siteId: "s1",
      kind: "ARTICLE_KEYWORD",
      status: "COMPLETED",
      idempotencyKey: "key-1",
      seed: "freediving course",
      providerTaskId: "task-1",
      costMicros: 4200,
      providerLanguageCode: "en",
      providerLocationCode: 2484,
      requestedBy: "article-research",
    });
    expect(rows[0].brief).toMatchObject({ family: "article_keyword_research", legacyRunId: "legacy-1" });
  });

  it("is idempotent: replaying the same run updates rather than duplicating", async () => {
    const { db, rows } = fakeDb();
    await syncArticleRunToResearchRun(db, run());
    await syncArticleRunToResearchRun(db, run({ status: "FAILED", errorCode: "PROVIDER_ERROR" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_ERROR" });
  });

  it("carries a parent link for serp children", async () => {
    const { db, rows } = fakeDb();
    await syncArticleRunToResearchRun(db, run({ parentRunId: "parent-1", kind: "ORGANIC_SERP" }));
    expect(rows[0].parentRunId).toBe("parent-1");
  });

  it("defaults cost to zero rather than null, since the column is non-null", async () => {
    const { db, rows } = fakeDb();
    await syncArticleRunToResearchRun(db, run({ costMicros: null }));
    expect(rows[0].costMicros).toBe(0);
  });
});

describe("DS-02 prelaunch shadow", () => {
  it("maps the prelaunch statuses without inventing new ones", async () => {
    const { prelaunchShadowStatus } = await import("@/lib/dataforseo/run-shadow");
    expect(prelaunchShadowStatus("COMPLETED")).toBe("COMPLETED");
    expect(prelaunchShadowStatus("PARTIAL")).toBe("COMPLETED");
    expect(prelaunchShadowStatus("FAILED")).toBe("FAILED");
    expect(prelaunchShadowStatus("RUNNING_PAID_RESEARCH")).toBe("RUNNING");
    expect(prelaunchShadowStatus("WAITING_FOR_SOURCES")).toBe("RUNNING");
    expect(prelaunchShadowStatus("REQUESTED")).toBe("QUEUED");
  });

  it("writes a project-scoped run with no site and keeps the legacy id traceable", async () => {
    const { syncPrelaunchRunToResearchRun } = await import("@/lib/dataforseo/run-shadow");
    const { db, rows } = fakeDb();
    await syncPrelaunchRunToResearchRun(db, {
      id: "legacy-prelaunch-1",
      projectId: "p1",
      status: "COMPLETED",
      brief: { business_goal: "Find launch markets" },
      taskLimit: 9,
      taskCount: 5,
      actualCostMicros: 12000,
      report: { sections: [] },
      errorCode: null,
      periodStart: AT,
      idempotencyKey: "prelaunch-key-1",
      requestedAt: AT,
      startedAt: AT,
      completedAt: AT,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      siteId: null,
      kind: "PRELAUNCH",
      status: "COMPLETED",
      title: "Find launch markets",
      costMicros: 12000,
      findingCount: 5,
    });
    expect((rows[0].brief as { legacyRunId?: string }).legacyRunId).toBe("legacy-prelaunch-1");
  });

  it("falls back to a dated title when the brief has no goal", async () => {
    const { syncPrelaunchRunToResearchRun } = await import("@/lib/dataforseo/run-shadow");
    const { db, rows } = fakeDb();
    await syncPrelaunchRunToResearchRun(db, {
      id: "legacy-prelaunch-2",
      projectId: "p1",
      status: "REQUESTED",
      brief: {},
      taskLimit: 9,
      taskCount: 0,
      actualCostMicros: 0,
      report: null,
      errorCode: null,
      periodStart: AT,
      idempotencyKey: "prelaunch-key-2",
      requestedAt: AT,
      startedAt: null,
      completedAt: null,
    });
    expect(rows[0].title).toBe("Prelaunch research 2026-11-03");
    expect(rows[0].status).toBe("QUEUED");
  });
});
