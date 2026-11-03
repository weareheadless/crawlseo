import type { PrismaClient } from "@prisma/client";

import type { ResearchRunKind, ResearchRunStatus } from "@prisma/client";

/**
 * DS-02 step 2: dual-write the article keyword family into `ResearchRun`.
 *
 * The cutover needs a populated target before any reader switches, otherwise the
 * switch would need a data backfill. This writes the shadow row at the one place
 * the run's final state is known — when the job finishes — so it stays simple and
 * cannot drift mid-run.
 *
 * Nothing reads it yet: behaviour is unchanged until step 3.
 */

export type RunShadowDb = Pick<PrismaClient, "researchRun">;

export type ArticleRunForShadow = {
  id: string;
  projectId: string;
  siteId: string;
  idempotencyKey: string;
  ideaSummary: string;
  seed: string;
  kind: string;
  language: string;
  country: string;
  providerLanguageCode: string | null;
  providerLocationCode: number | null;
  status: string;
  providerTaskId: string | null;
  costMicros: number | null;
  errorCode: string | null;
  requestedAt: Date;
  attemptedAt: Date | null;
  completedAt: Date | null;
  parentRunId: string | null;
};

/** The family's statuses map onto the spine's, without inventing new states. */
export function shadowStatus(status: string): ResearchRunStatus {
  switch (status) {
    case "COMPLETED":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    case "RUNNING":
      return "RUNNING";
    case "REQUESTED":
      return "QUEUED";
    default:
      return "QUEUED";
  }
}

export function shadowRunKind(): ResearchRunKind {
  return "ARTICLE_KEYWORD";
}

export async function syncArticleRunToResearchRun(
  db: RunShadowDb,
  run: ArticleRunForShadow
): Promise<{ id: string }> {
  const data = {
    siteId: run.siteId,
    projectId: run.projectId,
    kind: shadowRunKind(),
    status: shadowStatus(run.status),
    title: run.ideaSummary,
    brief: {
      family: "article_keyword_research",
      legacyRunId: run.id,
      seed: run.seed,
      articleKind: run.kind,
      language: run.language,
      country: run.country,
    } as never,
    idempotencyKey: run.idempotencyKey,
    parentRunId: run.parentRunId,
    seed: run.seed,
    providerTaskId: run.providerTaskId,
    providerLanguageCode: run.providerLanguageCode,
    providerLocationCode: run.providerLocationCode,
    costMicros: run.costMicros ?? 0,
    errorCode: run.errorCode,
    requestedBy: "article-research",
    startedAt: run.attemptedAt,
    completedAt: run.completedAt,
    attemptedAt: run.attemptedAt,
  };

  const row = await db.researchRun.upsert({
    where: {
      projectId_kind_idempotencyKey: {
        projectId: run.projectId,
        kind: shadowRunKind(),
        idempotencyKey: run.idempotencyKey,
      },
    },
    create: { ...data, createdAt: run.requestedAt },
    update: data,
    select: { id: true },
  });
  return row;
}

/**
 * DS-02 step 1 of the prelaunch cutover: write the project-scoped prelaunch run
 * into `ResearchRun` as kind `PRELAUNCH`.
 *
 * Prelaunch research has no site, which is why the unified table's `siteId` had to
 * become nullable first (migration 20261103170000). The legacy run id stays in the
 * brief so the shadow can always be traced back while the legacy row still exists.
 */
export type PrelaunchRunForShadow = {
  id: string;
  projectId: string;
  status: string;
  brief: unknown;
  taskLimit: number;
  taskCount: number;
  actualCostMicros: number;
  report: unknown;
  errorCode: string | null;
  periodStart: Date;
  idempotencyKey: string;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

/** PRELAUNCH has two in-flight states; the spine only needs "running". */
export function prelaunchShadowStatus(status: string): ResearchRunStatus {
  switch (status) {
    case "COMPLETED":
      return "COMPLETED";
    case "PARTIAL":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    case "RUNNING_PAID_RESEARCH":
    case "WAITING_FOR_SOURCES":
      return "RUNNING";
    default:
      return "QUEUED";
  }
}

export async function syncPrelaunchRunToResearchRun(
  db: RunShadowDb,
  run: PrelaunchRunForShadow
): Promise<{ id: string }> {
  const brief = (run.brief ?? {}) as { business_goal?: string };
  const title = brief.business_goal?.trim() || `Prelaunch research ${run.periodStart.toISOString().slice(0, 10)}`;
  const data = {
    siteId: null,
    projectId: run.projectId,
    kind: "PRELAUNCH" as const,
    status: prelaunchShadowStatus(run.status),
    title,
    brief: {
      family: "prelaunch_research",
      legacyRunId: run.id,
      period: run.periodStart.toISOString(),
      taskLimit: run.taskLimit,
      taskCount: run.taskCount,
      legacyBrief: run.brief,
    } as never,
    report: (run.report ?? undefined) as never,
    findingCount: run.taskCount,
    costMicros: run.actualCostMicros,
    errorCode: run.errorCode,
    idempotencyKey: run.idempotencyKey,
    requestedBy: null,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.requestedAt,
  };
  return db.researchRun.upsert({
    where: {
      projectId_kind_idempotencyKey: {
        projectId: run.projectId,
        kind: "PRELAUNCH",
        idempotencyKey: run.idempotencyKey,
      },
    },
    create: data,
    update: data,
    select: { id: true },
  });
}
