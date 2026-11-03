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
