import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { JobKind, SyncSource, SyncStatus } from "@prisma/client";
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
import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { runSeoResearch } from "@/lib/dataforseo/research";
import { runPrelaunchResearch } from "@/lib/dataforseo/prelaunch-runner";
import { runArticleKeywordResearch } from "@/lib/dataforseo/article-research";
import { runResearchRun } from "@/lib/research/runner";
import { runAgentTask } from "@/lib/agent-tasks/runner";
import { resumeWixPageDelivery, runWixPageTask } from "@/lib/agent-tasks/wix-page";
import { loadEnvConfig } from "@next/env";
import { bridgeKeywordRunToEvidence, releaseBridgedRunResult } from "@/lib/dataforseo/research-evidence";
import { syncArticleRunToResearchRun } from "@/lib/dataforseo/run-shadow";
import { bridgePrelaunchRunToEvidence, bridgeSeoResearchRunToEvidence } from "@/lib/dataforseo/seo-research-evidence";
import { runJoinFollowUps } from "@/lib/funnel/join-runner";
import { ensureTenantAnalysis } from "@/lib/tenants/analysis";
import { runMonthlyCycle } from "@/lib/jobs/monthly-cycle";

loadEnvConfig(process.cwd());

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
      if (!job.siteId) throw new JobExecutionError("GSC_SITE_REQUIRED");
      const dateRange = sourceDateRange(payload);
      const result = projectId
        ? await syncGSCDataForProject(projectId, job.siteId, integer(payload.daysBack, 90), syncRunId, dateRange)
        : await syncGSCDataForSite(text(payload.userId, ""), job.siteId, integer(payload.daysBack, 90), syncRunId, dateRange);
      if (!result.success) throw new JobExecutionError("GSC_SYNC_FAILED");
      return;
    }
    case JobKind.GA4_SYNC:
      if (!job.siteId) throw new JobExecutionError("GA4_SITE_REQUIRED");
      if (!projectId) throw new JobExecutionError("GA4_PROJECT_REQUIRED");
      if (!(await syncGA4DataForProject(projectId, job.siteId, syncRunId, sourceDateRange(payload))).success) {
        throw new JobExecutionError("GA4_SYNC_FAILED");
      }
      return;
    case JobKind.CRAWL: {
      if (!job.siteId) throw new JobExecutionError("CRAWL_SITE_REQUIRED");
      const site = await db.site.findFirst({
        where: { id: job.siteId, ...(projectId ? { projectId } : {}) },
        select: { domain: true },
      });
      if (!site) throw new JobExecutionError("SITE_NOT_FOUND");
      const crawlId = typeof payload.crawlId === "string" ? payload.crawlId : undefined;
      await runSiteCrawl(job.siteId, site.domain, integer(payload.maxPages, 200), crawlId);
      // Wave 6 cutover: the crawl now feeds the funnel directly. The legacy
      // action producer is retired; its table stays frozen and readable.
      try {
        await refreshFunnelForSite(db, job.siteId, { detectedBy: "crawl-job" });
      } catch (error) {
        console.error("[CrawlSEO worker] funnel refresh after crawl failed", error);
      }
      // Join free why legs from business knowledge. The how-leg collections are
      // paid, so the automatic path spends nothing; a human runs the script with a
      // ceiling when a how leg is worth collecting.
      if (projectId) {
        try {
          const joins = await runJoinFollowUps(db as never, { projectId, siteId: job.siteId, maxSpendMicros: 0 });
          if (joins.joined.length > 0) {
            console.log(`[CrawlSEO worker] joined ${joins.joined.length} missing leg(s) for ${job.siteId}`);
          }
        } catch (error) {
          console.error("[CrawlSEO worker] join follow-ups failed", error);
        }
      }
      return;
    }
    case JobKind.VITALS_SYNC:
      if (!job.siteId) throw new JobExecutionError("VITALS_SITE_REQUIRED");
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
      if (!job.siteId) {
        await runPrelaunchResearch(projectId, researchRunId);
        // Project-scoped prelaunch runs have no site. Their results now live in
        // the run report (no task rows), so the bridge reads the report.
        try {
          await bridgePrelaunchRunToEvidence(db as never, { projectId, researchRunId });
        } catch (error) {
          console.error("[CrawlSEO worker] prelaunch evidence bridge failed", error);
        }
        return;
      }
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
      // Wave 6: project completed task results into funnel evidence so the run
      // tables stop being the only home of this data.
      try {
        const bridged = await bridgeSeoResearchRunToEvidence(db as never, { projectId, siteId: job.siteId, researchRunId });
        if (bridged.skipped.length > 0) {
          console.warn(`[CrawlSEO worker] seo research evidence skipped ${bridged.skipped.length} task(s) for run ${researchRunId}`);
        }
      } catch (error) {
        console.error("[CrawlSEO worker] seo research evidence bridge failed", error);
      }
      return;
    }
    case JobKind.RESEARCH_RUN: {
      if (!job.siteId) throw new JobExecutionError("RESEARCH_SITE_REQUIRED");
      const researchRunId = text(payload.researchRunId, "");
      if (!researchRunId) throw new JobExecutionError("RESEARCH_RUN_ID_REQUIRED");
      await runResearchRun(researchRunId);
      // A scheduled run is the monthly one: collect the how leg for the gaps it
      // found, inside a bounded share of the monthly allowance. Manual runs stay
      // free so a test does not spend.
      const scheduled = await db.researchRun.findUnique({
        where: { id: researchRunId },
        select: { trigger: true, projectId: true, siteId: true, brief: true },
      });
      // The scheduled pass runs the same tenant pipeline every other entry point
      // runs, so a monthly run and a manual one cannot diverge.
      if (scheduled?.siteId) {
        try {
          const analysis = await ensureTenantAnalysis(db as never, scheduled.siteId, {
            apply: true,
            maxJoinSpendMicros: 300_000,
            maxAcquisitionSpendMicros: 300_000,
          });
          const joins = analysis.steps.find((step) => step.step === "joins");
          const acquisition = analysis.steps.find((step) => step.step === "acquisition");
          console.log(
            `[CrawlSEO worker] tenant analysis after scheduled run: acquisition ${acquisition?.detail ?? "not run"}; ${joins?.detail ?? "no join step"}`
          );
        } catch (error) {
          console.error("[CrawlSEO worker] scheduled tenant analysis failed", error);
        }
      }
      return;
    }
    case JobKind.AGENT_TASK: {
      if (!job.siteId) throw new JobExecutionError("AGENT_SITE_REQUIRED");
      const agentTaskId = text(payload.agentTaskId, "");
      if (!agentTaskId) throw new JobExecutionError("AGENT_TASK_ID_REQUIRED");
      const agentTask = await db.agentTask.findUnique({ where: { id: agentTaskId }, select: { kind: true } });
      if (agentTask?.kind === "wix_page") await runWixPageTask(agentTaskId);
      else await runAgentTask(agentTaskId);
      return;
    }
    case JobKind.WIX_DELIVERY: {
      if (!job.siteId) throw new JobExecutionError("AGENT_SITE_REQUIRED");
      const agentTaskId = text(payload.agentTaskId, "");
      if (!agentTaskId) throw new JobExecutionError("AGENT_TASK_ID_REQUIRED");
      await resumeWixPageDelivery(agentTaskId);
      return;
    }
    case JobKind.ARTICLE_KEYWORD_RESEARCH: {
      if (!projectId) throw new JobExecutionError("ARTICLE_RESEARCH_PROJECT_REQUIRED");
      if (!job.siteId) throw new JobExecutionError("ARTICLE_RESEARCH_SITE_REQUIRED");
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
      // Wave 6: project the stored keyword data into funnel evidence so the
      // demand map and detectors can use it. Additive; the legacy run row stays.
      try {
        const stored = await db.articleKeywordResearchRun.findUnique({
          where: { id: researchRunId },
          select: { id: true, siteId: true, projectId: true, providerTaskId: true, costMicros: true, result: true, language: true, country: true, completedAt: true, requestedAt: true },
        });
        if (stored) {
          const bridged = await bridgeKeywordRunToEvidence(db as never, stored);
          if (bridged.skipped > 0) {
            console.warn(`[CrawlSEO worker] keyword evidence skipped ${bridged.skipped} row(s): run ${stored.id} has no recorded cost`);
          }
          // One home for raw provider data: once the payload is in the evidence
          // store, drop the duplicate copy from the run row.
          if (bridged.stored > 0) await releaseBridgedRunResult(db as never, stored);
          // DS-02 step 2: dual-write the final state into the unified run table so
          // the later read switch needs no backfill.
          const shadowSource = await db.articleKeywordResearchRun.findUnique({
            where: { id: researchRunId },
            select: {
              id: true, projectId: true, siteId: true, idempotencyKey: true, ideaSummary: true, seed: true,
              kind: true, language: true, country: true, providerLanguageCode: true, providerLocationCode: true,
              status: true, providerTaskId: true, costMicros: true, errorCode: true, requestedAt: true,
              attemptedAt: true, completedAt: true, parentRunId: true,
            },
          });
          if (shadowSource) await syncArticleRunToResearchRun(db as never, shadowSource);
        }
      } catch (error) {
        console.error("[CrawlSEO worker] keyword evidence bridge failed", error);
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
    if (job.siteId) syncRun = await createSyncRun({ ...job, siteId: job.siteId });
    else syncRun = { id: "", jobId: job.id, siteId: "", source: SyncSource.DATAFORSEO, status: SyncStatus.PENDING, startedAt: null, finishedAt: null, attempt: job.attempts, errorCode: null, errorText: null, metadata: {}, createdAt: new Date(), updatedAt: new Date() };
  } catch {
    await failJob(job, workerId, "SYNC_RUN_CREATE_FAILED");
    return true;
  }
  const heartbeat = setInterval(() => {
    void heartbeatJob(job.id, workerId, leaseSeconds);
  }, Math.max(10_000, Math.floor((leaseSeconds * 1000) / 3)));

  try {
    if (syncRun.id) await startSyncRun(syncRun.id);
    await executeJob(job, syncRun.id);
    if (syncRun.id) await completeSyncRun(syncRun.id);
    await completeJob(job.id, workerId);
  } catch (error) {
    const code = error instanceof JobExecutionError ? error.code : "JOB_EXECUTION_FAILED";
    if (error instanceof JobExecutionError && error.defer) {
      if (syncRun.id) await failSyncRun(syncRun.id, code, code).catch(() => undefined);
      await deferJob(job, workerId, code);
    } else {
      if (syncRun.id) await failSyncRun(syncRun.id, code, code).catch(() => undefined);
      await failJob(job, workerId, code);
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export async function main(): Promise<void> {
  console.error(`[CrawlSEO worker] ${workerId} started`);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  // The monthly cycle runs from the worker, not from a script someone remembers
  // to run: every site, once a month, crawl -> search console -> research, and the
  // research run's completion runs the tenant pipeline.
  const cycleEveryMs = Number(process.env.MONTHLY_CYCLE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  let cycleRunning = false;
  const runCycle = async () => {
    if (cycleRunning) return;
    cycleRunning = true;
    try {
      const results = await runMonthlyCycle(db);
      const queued = results.flatMap((site) => site.stages.filter((stage) => stage.status === "queued").map((stage) => `${site.domain}:${stage.stage}`));
      const failed = results.flatMap((site) => site.stages.filter((stage) => stage.status === "failed").map((stage) => `${site.domain}:${stage.stage}=${stage.detail}`));
      if (queued.length || failed.length) {
        console.log(`[CrawlSEO worker] monthly cycle: ${queued.length} queued, ${failed.length} failed`, JSON.stringify({ queued, failed }));
      }
    } catch (error) {
      console.error("[CrawlSEO worker] monthly cycle failed", error instanceof Error ? error.message : "unknown");
    } finally {
      cycleRunning = false;
    }
  };
  void runCycle();
  const cycleTimer = setInterval(() => void runCycle(), Math.max(60_000, cycleEveryMs));
  cycleTimer.unref?.();

  while (!stopping) {
    const worked = await processNextJob();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  clearInterval(cycleTimer);
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
