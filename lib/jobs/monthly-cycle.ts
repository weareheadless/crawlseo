import { JobKind, JobStatus, type PrismaClient } from "@prisma/client";

import { enqueueJob } from "@/lib/jobs/queue";
import { createResearchRun } from "@/lib/research/service";
import { resolveSiteContext } from "@/lib/site/context";

/**
 * The monthly cycle, for every site.
 *
 * Nothing ran on a schedule before this: jobs were created only when a human hit
 * an API route, so "crawlseo analyses all sites monthly" was true only for tenants
 * somebody had been operating by hand. The worker now calls this on a timer, and
 * the same code backs the CLI, so there is one definition of the cycle.
 *
 * One cycle per site per calendar month, keyed so it cannot double-queue:
 *   crawl → search-console sync → research run
 * and the research run's completion runs the tenant pipeline (business knowledge,
 * joins, funnel refresh) in the worker.
 *
 * A stage that is already queued or completed this month is skipped, not repeated.
 */

export type MonthlyCycleStage = {
  stage: "crawl" | "search-console" | "research";
  status: "queued" | "skipped" | "failed";
  detail: string;
};

export type MonthlyCycleSite = {
  siteId: string;
  domain: string;
  month: string;
  stages: MonthlyCycleStage[];
};

export type MonthlyCycleOptions = {
  now?: Date;
  /** Restrict to these sites. Default: every site attached to a project. */
  siteIds?: string[];
  /** Report what would be queued without queueing it. */
  dryRun?: boolean;
};

function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function runMonthlyCycle(
  db: PrismaClient,
  opts: MonthlyCycleOptions = {}
): Promise<MonthlyCycleSite[]> {
  const now = opts.now ?? new Date();
  const month = monthKey(now);
  const key = (stage: string) => `monthly:${month}:${stage}`;

  const sites = await db.site.findMany({
    where: {
      projectId: { not: null },
      // A retired record is kept for audit, not analysed.
      retiredAt: null,
      ...(opts.siteIds?.length ? { id: { in: opts.siteIds } } : {}),
    },
    select: {
      id: true,
      domain: true,
      projectId: true,
      userId: true,
      siteProfile: { select: { topics: true, audience: true } },
      researchPolicy: { select: { enabled: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const results: MonthlyCycleSite[] = [];

  for (const site of sites) {
    const stages: MonthlyCycleStage[] = [];

    // 1. Crawl: page-level evidence has to be current before the funnel scores it.
    const crawlKey = key("crawl");
    const crawlJob = await db.job.findUnique({
      where: { siteId_kind_idempotencyKey: { siteId: site.id, kind: JobKind.CRAWL, idempotencyKey: crawlKey } },
      select: { id: true, status: true },
    });
    if (crawlJob) {
      stages.push({ stage: "crawl", status: "skipped", detail: `already ${crawlJob.status.toLowerCase()} this month` });
    } else if (opts.dryRun) {
      stages.push({ stage: "crawl", status: "queued", detail: "would queue" });
    } else {
      try {
        const crawl = await db.crawl.create({ data: { siteId: site.id, status: "PENDING", maxPages: 500 }, select: { id: true } });
        await enqueueJob({
          projectId: site.projectId,
          siteId: site.id,
          kind: JobKind.CRAWL,
          payload: { crawlId: crawl.id, maxPages: 500 },
          idempotencyKey: crawlKey,
        });
        stages.push({ stage: "crawl", status: "queued", detail: `crawl ${crawl.id}` });
      } catch (error) {
        stages.push({ stage: "crawl", status: "failed", detail: error instanceof Error ? error.message.slice(0, 120) : "failed" });
      }
    }

    // 2. Search Console: the first-party demand the funnel scores against.
    const gscKey = key("search-console");
    const gscJob = await db.job.findUnique({
      where: { siteId_kind_idempotencyKey: { siteId: site.id, kind: JobKind.GSC_SYNC, idempotencyKey: gscKey } },
      select: { id: true, status: true },
    });
    if (gscJob) {
      stages.push({ stage: "search-console", status: "skipped", detail: `already ${gscJob.status.toLowerCase()} this month` });
    } else if (opts.dryRun) {
      stages.push({ stage: "search-console", status: "queued", detail: "would queue" });
    } else {
      try {
        await enqueueJob({
          projectId: site.projectId,
          siteId: site.id,
          kind: JobKind.GSC_SYNC,
          payload: { daysBack: 90 },
          idempotencyKey: gscKey,
        });
        stages.push({ stage: "search-console", status: "queued", detail: "90 days back" });
      } catch (error) {
        stages.push({ stage: "search-console", status: "failed", detail: error instanceof Error ? error.message.slice(0, 120) : "failed" });
      }
    }

    // 3. Research: the market evidence that becomes the why leg.
    const researchKey = key("research");
    const existingRun = await db.researchRun.findFirst({ where: { siteId: site.id, scheduleKey: researchKey }, select: { id: true } });
    if (existingRun) {
      stages.push({ stage: "research", status: "skipped", detail: `run ${existingRun.id} already created this month` });
    } else if (opts.dryRun) {
      stages.push({ stage: "research", status: "queued", detail: "would queue" });
    } else {
      if (site.researchPolicy && site.researchPolicy.enabled === false) {
        // The owner switched research off. Crawl and search-console still run, but
        // no run is created — and the skip is reported rather than silent.
        stages.push({ stage: "research", status: "skipped", detail: "research disabled by the owner" });
        results.push({ siteId: site.id, domain: site.domain, month, stages });
        continue;
      }
      const topics = Array.isArray(site.siteProfile?.topics)
        ? (site.siteProfile?.topics as unknown[]).filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0)
        : [];
      if (topics.length === 0) {
        // Not a failure of the cycle: the site has no topics, and a run would have
        // nothing to ask about. Report it so the gap is visible.
        stages.push({ stage: "research", status: "skipped", detail: "no research topics configured" });
      } else {
        try {
          const context = await resolveSiteContext(db as never, site.id);
          const run = await createResearchRun(site.id, {
            title: `Monthly market research — ${month}`,
            kind: "MARKET",
            trigger: "SCHEDULED",
            topics,
            audience: typeof site.siteProfile?.audience === "string" ? site.siteProfile.audience : undefined,
            market: context.market ?? undefined,
            language: context.language,
            questions: [],
            recencyDays: 90,
            providers: ["reddit", "news", "competitor"],
          }, site.userId ?? "monthly-cycle", researchKey);
          await enqueueJob({
            projectId: site.projectId,
            siteId: site.id,
            kind: JobKind.RESEARCH_RUN,
            payload: { researchRunId: run.id },
            idempotencyKey: `research-run:${run.id}`,
            maxAttempts: 2,
          });
          stages.push({ stage: "research", status: "queued", detail: `run ${run.id}` });
        } catch (error) {
          stages.push({ stage: "research", status: "failed", detail: error instanceof Error ? error.message.slice(0, 120) : "failed" });
        }
      }
    }

    results.push({ siteId: site.id, domain: site.domain, month, stages });
  }

  return results;
}
