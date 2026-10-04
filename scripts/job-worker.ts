import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { JobKind } from "@prisma/client";
import { db } from "@/lib/db";
import {
  claimNextJob,
  completeJob,
  completeSyncRun,
  createSyncRun,
  deferJob,
  failJob,
  failSyncRun,
  heartbeatJob,
  startSyncRun,
} from "@/lib/jobs/queue";
import { syncGSCDataForProject, syncGSCDataForSite } from "@/lib/workers/gsc-sync";
import { syncGA4DataForProject } from "@/lib/workers/ga4-sync";
import { syncVitalsForProject, syncVitalsForSite } from "@/lib/workers/vitals-sync";
import { runSiteCrawl } from "@/lib/crawler/engine";
import { runSeoResearch } from "@/lib/dataforseo/research";
import { runArticleKeywordResearch } from "@/lib/dataforseo/article-research";

const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const pollMs = Math.max(250, Number(process.env.JOB_WORKER_POLL_MS ?? 1000));
const leaseSeconds = Math.max(30, Number(process.env.JOB_WORKER_LEASE_SECONDS ?? 120));

function payloadOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function sourceDateRange(payload: Record<string, unknown>): { startDate: string; endDate: string } | undefined {
  const startDate = typeof payload.periodStart === "string" ? payload.periodStart : undefined;
  const endDate = typeof payload.periodEnd === "string" ? payload.periodEnd : undefined;
  if (!startDate && !endDate) return undefined;
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new JobExecutionError("SOURCE_DATE_RANGE_INVALID");
  }
  return { startDate, endDate };
}

class JobExecutionError extends Error {
  readonly code: string;
  readonly defer: boolean;

  constructor(code: string, defer = false) {
    super(code);
    this.code = code;
    this.defer = defer;
  }
}

async function executeJob(
  job: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>,
  syncRunId: string
): Promise<void> {
  const payload = payloadOf(job.payload);
  const projectId = job.projectId;

  switch (job.kind) {
    case JobKind.GSC_SYNC: {
      const dateRange = sourceDateRange(payload);
      const result = projectId
        ? await syncGSCDataForProject(projectId, job.siteId, integer(payload.daysBack, 28), syncRunId, dateRange)
        : await syncGSCDataForSite(text(payload.userId, ""), job.siteId, integer(payload.daysBack, 28), syncRunId, dateRange);
      if (!result.success) throw new JobExecutionError("GSC_SYNC_FAILED");
      return;
    }
    case JobKind.GA4_SYNC:
      if (!projectId) throw new JobExecutionError("GA4_PROJECT_REQUIRED");
      if (!(await syncGA4DataForProject(projectId, job.siteId, syncRunId, sourceDateRange(payload))).success) {
        throw new JobExecutionError("GA4_SYNC_FAILED");
      }
      return;
    case JobKind.CRAWL: {
      const site = await db.site.findFirst({
        where: { id: job.siteId, ...(projectId ? { projectId } : {}) },
        select: { domain: true },
      });
      if (!site) throw new JobExecutionError("SITE_NOT_FOUND");
      const crawlId = typeof payload.crawlId === "string" ? payload.crawlId : undefined;
      await runSiteCrawl(job.siteId, site.domain, integer(payload.maxPages, 200), crawlId);
      return;
    }
    case JobKind.VITALS_SYNC:
      if (projectId) {
        await syncVitalsForProject(projectId, job.siteId, integer(payload.limit, 5));
      } else {
        await syncVitalsForSite(text(payload.userId, ""), job.siteId, integer(payload.limit, 5));
      }
      return;
    case JobKind.SEO_RESEARCH: {
      if (!projectId) throw new JobExecutionError("SEO_RESEARCH_PROJECT_REQUIRED");
      const researchRunId = text(payload.researchRunId, "");
      if (!researchRunId) throw new JobExecutionError("SEO_RESEARCH_RUN_REQUIRED");
      try {
        const result = await runSeoResearch(projectId, job.siteId, researchRunId);
        if (result.status === "WAITING_FOR_SOURCES") {
          throw new JobExecutionError("SEO_RESEARCH_WAITING_FOR_SOURCES", true);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "ResearchNotFoundError") {
          throw new JobExecutionError("SEO_RESEARCH_NOT_FOUND");
        }
        throw error;
      }
      return;
    }
    case JobKind.ARTICLE_KEYWORD_RESEARCH: {
      if (!projectId) throw new JobExecutionError("ARTICLE_RESEARCH_PROJECT_REQUIRED");
      const researchRunId = text(payload.articleResearchRunId, "");
      if (!researchRunId) throw new JobExecutionError("ARTICLE_RESEARCH_RUN_REQUIRED");
      try {
        await runArticleKeywordResearch(projectId, job.siteId, researchRunId);
      } catch (error) {
        if (error instanceof Error && error.name === "ArticleResearchNotFoundError") {
          throw new JobExecutionError("ARTICLE_RESEARCH_NOT_FOUND");
        }
        throw error;
      }
      return;
    }
  }
}

export async function processNextJob(): Promise<boolean> {
  const job = await claimNextJob(workerId, leaseSeconds);
  if (!job) return false;

  let syncRun: Awaited<ReturnType<typeof createSyncRun>>;
  try {
    syncRun = await createSyncRun(job);
  } catch {
    await failJob(job, workerId, "SYNC_RUN_CREATE_FAILED");
    return true;
  }
  const heartbeat = setInterval(() => {
    void heartbeatJob(job.id, workerId, leaseSeconds);
  }, Math.max(10_000, Math.floor((leaseSeconds * 1000) / 3)));

  try {
    await startSyncRun(syncRun.id);
    await executeJob(job, syncRun.id);
    await completeSyncRun(syncRun.id);
    await completeJob(job.id, workerId);
  } catch (error) {
    const code = error instanceof JobExecutionError ? error.code : "JOB_EXECUTION_FAILED";
    if (error instanceof JobExecutionError && error.defer) {
      await failSyncRun(syncRun.id, code, code).catch(() => undefined);
      await deferJob(job, workerId, code);
    } else {
      await failSyncRun(syncRun.id, code, code).catch(() => undefined);
      await failJob(job, workerId, code);
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

async function main(): Promise<void> {
  console.error(`[CrawlSEO worker] ${workerId} started`);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  while (!stopping) {
    const worked = await processNextJob();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  await db.$disconnect();
  console.error(`[CrawlSEO worker] ${workerId} stopped`);
}

if (process.argv[1]?.endsWith("job-worker.ts")) {
  main().catch(async (error) => {
    console.error("[CrawlSEO worker] fatal error", error instanceof Error ? error.message : "unknown");
    await db.$disconnect();
    process.exit(1);
  });
}
