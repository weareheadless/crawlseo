import { JobKind, JobStatus, SyncSource, SyncStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_SECONDS = 120;

export type EnqueueJobInput = {
  projectId?: string | null;
  siteId: string;
  kind: JobKind;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  maxAttempts?: number;
};

export function sourceForJobKind(kind: JobKind): SyncSource {
  switch (kind) {
    case JobKind.GSC_SYNC:
      return SyncSource.GSC;
    case JobKind.GA4_SYNC:
      return SyncSource.GA4;
    case JobKind.CRAWL:
      return SyncSource.CRAWL;
    case JobKind.VITALS_SYNC:
      return SyncSource.VITALS;
    case JobKind.SEO_RESEARCH:
    case JobKind.ARTICLE_KEYWORD_RESEARCH:
      return SyncSource.DATAFORSEO;
    case JobKind.RESEARCH_RUN:
      return SyncSource.RESEARCH;
    case JobKind.AGENT_TASK:
      return SyncSource.AGENT;
  }
}

export async function enqueueJob(input: EnqueueJobInput) {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 240) {
    throw new Error("A non-empty job idempotency key is required");
  }
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 10));
  const payload = input.payload ?? {};

  const existing = await db.job.findUnique({
    where: {
      siteId_kind_idempotencyKey: {
        siteId: input.siteId,
        kind: input.kind,
        idempotencyKey,
      },
    },
  });
  if (existing) return existing;

  try {
    return await db.job.create({
      data: {
        projectId: input.projectId ?? null,
        siteId: input.siteId,
        kind: input.kind,
        payload: payload as Prisma.InputJsonValue,
        idempotencyKey,
        maxAttempts,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const winner = await db.job.findUnique({
        where: {
          siteId_kind_idempotencyKey: {
            siteId: input.siteId,
            kind: input.kind,
            idempotencyKey,
          },
        },
      });
      if (winner) return winner;
    }
    throw error;
  }
}

export async function claimNextJob(
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS
) {
  const lease = Math.max(15, Math.min(Math.floor(leaseSeconds), 900));
  // A worker may die after creating its audit row but before completing the
  // job. Close that attempt before another worker claims the expired lease.
  await db.$executeRaw`
    UPDATE "SyncRun"
    SET "status" = 'FAILED'::"SyncStatus",
        "finishedAt" = NOW(),
        "errorCode" = 'LEASE_EXPIRED',
        "errorText" = 'Worker lease expired',
        "updatedAt" = NOW()
    WHERE "status" IN ('PENDING'::"SyncStatus", 'RUNNING'::"SyncStatus")
      AND "jobId" IN (
        SELECT "id"
        FROM "Job"
        WHERE "status" = 'RUNNING'::"JobStatus"
          AND "leaseExpiresAt" < NOW()
      )
  `.catch(() => undefined);
  await db.$executeRaw`
    UPDATE "Job"
    SET "status" = 'FAILED'::"JobStatus",
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "heartbeatAt" = NULL,
        "updatedAt" = NOW()
    WHERE "status" = 'RUNNING'::"JobStatus"
      AND "leaseExpiresAt" < NOW()
      AND "attempts" >= "maxAttempts"
  `.catch(() => undefined);

  const claimed = await db.$queryRaw<Array<{ id: string }>>`
    WITH candidate AS (
      SELECT "id"
      FROM "Job"
      WHERE (
        ("status" = 'PENDING'::"JobStatus" AND "nextAttemptAt" <= NOW())
        OR
        ("status" = 'RUNNING'::"JobStatus" AND "leaseExpiresAt" < NOW())
      )
      AND "attempts" < "maxAttempts"
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "Job" AS job
    SET "status" = 'RUNNING'::"JobStatus",
        "attempts" = job."attempts" + 1,
        "leaseOwner" = ${workerId},
        "leaseExpiresAt" = NOW() + (${lease} * INTERVAL '1 second'),
        "heartbeatAt" = NOW(),
        "updatedAt" = NOW()
    FROM candidate
    WHERE job."id" = candidate."id"
    RETURNING job."id"
  `;

  const id = claimed[0]?.id;
  return id ? db.job.findUnique({ where: { id } }) : null;
}

export async function heartbeatJob(
  jobId: string,
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS
): Promise<boolean> {
  const lease = Math.max(15, Math.min(Math.floor(leaseSeconds), 900));
  const result = await db.job.updateMany({
    where: { id: jobId, status: JobStatus.RUNNING, leaseOwner: workerId },
    data: {
      heartbeatAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + lease * 1000),
    },
  });
  return result.count === 1;
}

export async function createSyncRun(job: {
  id: string;
  siteId: string;
  kind: JobKind;
  attempts: number;
  projectId: string | null;
}) {
  return db.syncRun.create({
    data: {
      jobId: job.id,
      siteId: job.siteId,
      source: sourceForJobKind(job.kind),
      attempt: job.attempts,
      metadata: {
        kind: job.kind,
        projectId: job.projectId,
      },
    },
  });
}

export async function startSyncRun(syncRunId: string): Promise<void> {
  await db.syncRun.update({
    where: { id: syncRunId },
    data: { status: SyncStatus.RUNNING, startedAt: new Date() },
  });
}

export async function completeSyncRun(syncRunId: string): Promise<void> {
  await db.syncRun.update({
    where: { id: syncRunId },
    data: { status: SyncStatus.COMPLETED, finishedAt: new Date() },
  });
}

export async function failSyncRun(
  syncRunId: string,
  errorCode: string,
  errorText?: string
): Promise<void> {
  await db.syncRun.update({
    where: { id: syncRunId },
    data: {
      status: SyncStatus.FAILED,
      finishedAt: new Date(),
      errorCode: errorCode.slice(0, 120),
      errorText: errorText?.slice(0, 500),
    },
  });
}

export async function completeJob(jobId: string, workerId: string): Promise<void> {
  await db.job.updateMany({
    where: { id: jobId, status: JobStatus.RUNNING, leaseOwner: workerId },
    data: {
      status: JobStatus.COMPLETED,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastErrorCode: null,
    },
  });
}

export async function failJob(
  job: { id: string; attempts: number; maxAttempts: number },
  workerId: string,
  errorCode: string
): Promise<void> {
  const retry = job.attempts < job.maxAttempts;
  const delaySeconds = Math.min(3600, 60 * 2 ** Math.max(0, job.attempts - 1));
  await db.job.updateMany({
    where: { id: job.id, status: JobStatus.RUNNING, leaseOwner: workerId },
    data: {
      status: retry ? JobStatus.PENDING : JobStatus.FAILED,
      nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastErrorCode: errorCode.slice(0, 120),
    },
  });
}

/**
 * Put an orchestration job back on the queue without consuming a retry when it
 * is waiting on independently scheduled source jobs.
 */
export async function deferJob(
  job: { id: string; attempts: number },
  workerId: string,
  errorCode: string,
  delaySeconds = 120
): Promise<void> {
  await db.job.updateMany({
    where: { id: job.id, status: JobStatus.RUNNING, leaseOwner: workerId },
    data: {
      status: JobStatus.PENDING,
      attempts: { decrement: Math.min(1, Math.max(0, job.attempts)) },
      nextAttemptAt: new Date(Date.now() + Math.max(15, delaySeconds) * 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastErrorCode: errorCode.slice(0, 120),
    },
  });
}
