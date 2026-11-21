import { JobKind, type PrismaClient } from "@prisma/client";

import { enqueueJob } from "@/lib/jobs/queue";
import { normalizeResearchCadence, type ResearchCadence } from "@/lib/research/policy";
import { researchCadenceWindow } from "@/lib/research/schedule";
import { createResearchRun } from "@/lib/research/service";
import { bundleKey } from "@/lib/research/schedule";
import { topicMapKey } from "@/lib/research/topic-map";
import { runTopicMap } from "@/lib/research/topic-map-run";
import { runWeeklyRefresh } from "@/lib/research/weekly-refresh";
import { resolveSiteContext } from "@/lib/site/context";
import { ensureTenantAnalysis } from "@/lib/tenants/analysis";

/**
 * The site cycle: the one scheduler.
 *
 * Nothing ran on a schedule before this module: jobs were created when a human
 * hit an API route or remembered a script, so "CrawlSEO analyses every site"
 * was true only for the sites somebody operated by hand. The worker calls this
 * on a timer; the CLI calls the same function for one site.
 *
 * Stages are ordered by dependency, keyed by period so a second tick queues
 * nothing, and a stage whose dependency has not finished reports `blocked` with
 * the dependency's name instead of being silently skipped:
 *
 *   daily    knowledge (extract once from the site's own pages when missing)
 *   weekly   crawl → search-console → weekly sweep → research (policy cadence)
 *   monthly  bundle, only after the month's research run has finished
 *
 * The bundle stays paid and capped; the cycle decides when it is allowed to run,
 * never how much it spends. The topic map remains a reviewed step: it proposes a
 * taxonomy a human accepts, and research candidates wait for that decision.
 */

export type SiteCycleCadence = "daily" | "weekly" | "monthly";
export type SiteCycleStageName = "knowledge" | "crawl" | "search-console" | "weekly-sweep" | "research" | "topic-map" | "bundle";
export type SiteCycleStatus = "queued" | "completed" | "skipped" | "blocked" | "failed";

export type SiteCycleStage = {
  stage: SiteCycleStageName;
  cadence: SiteCycleCadence;
  status: SiteCycleStatus;
  detail: string;
};

export type SiteCycleSite = {
  siteId: string;
  domain: string;
  week: string;
  month: string;
  stages: SiteCycleStage[];
};

export type SiteCycleOptions = {
  now?: Date;
  /** Restrict to these sites. Default: every active site attached to a project. */
  siteIds?: string[];
  /** Report what would run without writing or paying. */
  dryRun?: boolean;
};

function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function utcMonthBounds(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/** Research cadence comes from the owner's policy; "manual" means no schedule. */
function researchPeriod(cadence: ResearchCadence, now: Date, timeZone: string): string | null {
  if (cadence === "manual") return null;
  return researchCadenceWindow(cadence, now, timeZone).key;
}

export async function runSiteCycle(db: PrismaClient, opts: SiteCycleOptions = {}): Promise<SiteCycleSite[]> {
  const now = opts.now ?? new Date();
  const month = monthKey(now);
  const bounds = utcMonthBounds(now);

  const sites = await db.site.findMany({
    where: {
      projectId: { not: null },
      retiredAt: null,
      ...(opts.siteIds?.length ? { id: { in: opts.siteIds } } : {}),
    },
    select: {
      id: true,
      domain: true,
      projectId: true,
      userId: true,
      siteProfile: { select: { topics: true, audience: true } },
      researchPolicy: { select: { enabled: true, cadence: true } },
      project: { select: { researchBudgetTimeZone: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const results: SiteCycleSite[] = [];

  for (const site of sites) {
    const timeZone = site.project?.researchBudgetTimeZone ?? "UTC";
    const week = researchCadenceWindow("weekly", now, timeZone).key;
    const stages: SiteCycleStage[] = [];
    const push = (stage: SiteCycleStageName, cadence: SiteCycleCadence, status: SiteCycleStatus, detail: string) => {
      stages.push({ stage, cadence, status, detail });
    };

    // 0. Knowledge. A new site has no profile, no knowledge and no topics; every
    //    later stage either needs them or would produce a plan that fits any site
    //    in the market. Extraction is free and idempotent (it keeps a usable
    //    document), so the daily stage is the gate rather than a reminder.
    let knowledgeReady = true;
    if (opts.dryRun) {
      push("knowledge", "daily", "skipped", "would ensure a usable business-knowledge document");
    } else {
      try {
        const analysis = await ensureTenantAnalysis(db, site.id, {
          apply: true,
          bootstrapOnly: true,
          skipResearch: true,
          requestedBy: "site-cycle",
          now,
        });
        const knowledge = analysis.steps.find((step) => step.step === "business-knowledge");
        knowledgeReady = knowledge?.status !== "failed" && knowledge?.status !== "missing";
        push("knowledge", "daily", knowledgeReady ? "completed" : "failed", knowledge?.detail ?? "knowledge step not reported");
      } catch (error) {
        knowledgeReady = false;
        push("knowledge", "daily", "failed", error instanceof Error ? error.message.slice(0, 160) : "tenant bootstrap failed");
      }
    }

    // 1. Crawl. Page-level evidence has to be current before the funnel scores it.
    const crawlKey = `cycle:${week}:crawl`;
    const crawlJob = await db.job.findUnique({
      where: { siteId_kind_idempotencyKey: { siteId: site.id, kind: JobKind.CRAWL, idempotencyKey: crawlKey } },
      select: { id: true, status: true },
    });
    if (crawlJob) {
      push("crawl", "weekly", "skipped", `already ${crawlJob.status.toLowerCase()} this week`);
    } else if (opts.dryRun) {
      push("crawl", "weekly", "queued", "would queue");
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
        push("crawl", "weekly", "queued", `crawl ${crawl.id}`);
      } catch (error) {
        push("crawl", "weekly", "failed", error instanceof Error ? error.message.slice(0, 160) : "failed");
      }
    }

    // 2. Search Console: the first-party demand the funnel scores against.
    const gscKey = `cycle:${week}:search-console`;
    const gscJob = await db.job.findUnique({
      where: { siteId_kind_idempotencyKey: { siteId: site.id, kind: JobKind.GSC_SYNC, idempotencyKey: gscKey } },
      select: { id: true, status: true },
    });
    if (gscJob) {
      push("search-console", "weekly", "skipped", `already ${gscJob.status.toLowerCase()} this week`);
    } else if (opts.dryRun) {
      push("search-console", "weekly", "queued", "would queue");
    } else {
      try {
        await enqueueJob({
          projectId: site.projectId,
          siteId: site.id,
          kind: JobKind.GSC_SYNC,
          payload: { daysBack: 90 },
          idempotencyKey: gscKey,
        });
        push("search-console", "weekly", "queued", "90 days back");
      } catch (error) {
        push("search-console", "weekly", "failed", error instanceof Error ? error.message.slice(0, 160) : "failed");
      }
    }

    // 3. Weekly sweep: refresh first-party evidence, bounded news, timely items.
    //    Free (no provider calls) and idempotent by week.
    if (!knowledgeReady) {
      push("weekly-sweep", "weekly", "blocked", "blocked: knowledge is not usable");
    } else if (opts.dryRun) {
      push("weekly-sweep", "weekly", "queued", "would run");
    } else {
      try {
        const sweep = await runWeeklyRefresh(db, { siteId: site.id, mode: "execute", now });
        push("weekly-sweep", "weekly", sweep.status === "existing" ? "skipped" : "completed",
          `${sweep.week}: ${sweep.news.stored} source(s), ${sweep.timely.stored} timely proposal(s)`);
      } catch (error) {
        push("weekly-sweep", "weekly", "failed", error instanceof Error ? error.message.slice(0, 160) : "failed");
      }
    }

    // 4. Research, at the cadence the owner declared. A manual cadence is a
    //    decision, not a failure, and it is reported as one.
    const cadence = normalizeResearchCadence(site.researchPolicy?.cadence);
    const period = researchPeriod(cadence, now, timeZone);
    // The period key is shared with the operator script, so a manual backfill and
    // the scheduler cannot create two runs for the same window.
    const researchKey = period;
    const existingRun = researchKey
      ? await db.researchRun.findFirst({ where: { siteId: site.id, scheduleKey: researchKey }, select: { id: true, status: true } })
      : null;
    if (!knowledgeReady) {
      push("research", cadence === "monthly" ? "monthly" : "weekly", "blocked", "blocked: knowledge is not usable");
    } else if (site.researchPolicy?.enabled === false) {
      push("research", "weekly", "skipped", "research disabled by the owner");
    } else if (!researchKey) {
      push("research", "weekly", "skipped", "manual cadence: no scheduled run");
    } else if (existingRun) {
      push("research", "weekly", "skipped", `run ${existingRun.id} already ${existingRun.status.toLowerCase()} in ${period}`);
    } else if (opts.dryRun) {
      push("research", "weekly", "queued", `would queue for ${period}`);
    } else {
      // Re-read the profile: the bootstrap above may have derived topics in this
      // same pass, and the site row was loaded before it ran.
      const freshProfile = await db.siteProfile.findUnique({
        where: { siteId: site.id },
        select: { topics: true, audience: true },
      });
      const topics = Array.isArray(freshProfile?.topics)
        ? (freshProfile.topics as unknown[]).filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0)
        : [];
      if (topics.length === 0) {
        push("research", "weekly", "skipped", "no research topics: the run has nothing to ask about");
      } else {
        try {
          const context = await resolveSiteContext(db as never, site.id);
          const run = await createResearchRun(site.id, {
            title: `Scheduled market research — ${period}`,
            kind: "MARKET",
            trigger: "SCHEDULED",
            topics,
            audience: typeof freshProfile?.audience === "string" ? freshProfile.audience : undefined,
            market: context.market ?? undefined,
            language: context.language,
            questions: [],
            recencyDays: 90,
            providers: ["reddit", "news", "competitor"],
          }, site.userId ?? "site-cycle", researchKey);
          await enqueueJob({
            projectId: site.projectId,
            siteId: site.id,
            kind: JobKind.RESEARCH_RUN,
            payload: { researchRunId: run.id },
            idempotencyKey: `research-run:${run.id}`,
            maxAttempts: 2,
          });
          push("research", "weekly", "queued", `run ${run.id} for ${period}`);
        } catch (error) {
          push("research", "weekly", "failed", error instanceof Error ? error.message.slice(0, 160) : "failed");
        }
      }
    }

    // 5. Topic map and taxonomy, monthly, before the bundle: the taxonomy decides
    //    which queries the bundle may buy, so refreshing it after the spend would
    //    apply this month's decision next month. The map is approved automatically
    //    (the model proposes the job map, the taxonomy is its projection) and the
    //    review marker asks a person to read it; see lib/research/taxonomy-review.ts.
    const topicMapIdempotency = topicMapKey(site.id, month);
    const existingTopicMap = await db.researchRun.findFirst({
      where: { siteId: site.id, idempotencyKey: topicMapIdempotency },
      select: { id: true, status: true },
    });
    const completedCrawl = await db.crawl.findFirst({
      where: { siteId: site.id, status: "COMPLETED" },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    });
    const measuredDemand = site.projectId
      ? await db.evidenceRecord.count({
          where: { projectId: site.projectId, siteId: site.id, kind: { in: ["keyword_rank", "keyword_metrics"] }, supersededById: null },
        })
      : 0;

    if (existingTopicMap?.status === "COMPLETED") {
      push("topic-map", "monthly", "skipped", `topic map ${existingTopicMap.id} already completed for ${month}`);
    } else if (!knowledgeReady) {
      push("topic-map", "monthly", "blocked", "blocked: knowledge is not usable");
    } else if (!completedCrawl) {
      push("topic-map", "monthly", "blocked", "blocked: no completed crawl to map pages from");
    } else if (measuredDemand === 0) {
      push("topic-map", "monthly", "skipped", "no measured demand yet: the first bundle seeds it");
    } else if (opts.dryRun) {
      push("topic-map", "monthly", "queued", `would rebuild the taxonomy for ${month}`);
    } else {
      try {
        const map = await runTopicMap(db, {
          siteId: site.id,
          month,
          mode: "execute",
          approval: `auto:site-cycle:${month}`,
          ai: true,
          refreshJobMap: true,
          now,
        });
        push("topic-map", "monthly", map.status === "existing" ? "skipped" : "completed",
          map.map
            ? `${map.map.clusters.length} cluster(s), ${map.taxonomy?.topics.length ?? 0} topic(s), auto-approved for review`
            : `existing run ${map.runId}`);
      } catch (error) {
        push("topic-map", "monthly", "failed", error instanceof Error ? error.message.slice(0, 160) : "failed");
      }
    }

    // 6. Monthly bundle. It measures demand, so it runs after the month's research
    //    has named that demand. Research disabled is a declared state, and then the
    //    bundle runs from Search Console alone.
    const researchDisabled = site.researchPolicy?.enabled === false;
    const monthResearch = await db.researchRun.findFirst({
      where: { siteId: site.id, createdAt: { gte: bounds.start, lt: bounds.end } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    const researchFinished = researchDisabled || Boolean(
      monthResearch && (monthResearch.status === "COMPLETED" || monthResearch.status === "PARTIAL")
    );
    const bundleIdempotency = bundleKey(site.id, month);
    const existingBundle = await db.researchRun.findFirst({
      where: { siteId: site.id, idempotencyKey: bundleIdempotency },
      select: { id: true, status: true },
    });

    if (existingBundle) {
      push("bundle", "monthly", "skipped", `bundle ${existingBundle.id} already ${existingBundle.status.toLowerCase()} for ${month}`);
    } else if (!knowledgeReady) {
      push("bundle", "monthly", "blocked", "blocked: knowledge is not usable");
    } else if (!researchFinished) {
      push("bundle", "monthly", "blocked",
        monthResearch ? `blocked: research run ${monthResearch.id} is ${monthResearch.status.toLowerCase()}` : "blocked: no research run this month");
    } else if (opts.dryRun) {
      push("bundle", "monthly", "queued", `would queue for ${month}`);
    } else {
      try {
        await enqueueJob({
          projectId: site.projectId,
          siteId: site.id,
          kind: JobKind.BUNDLE,
          payload: { month, approval: `scheduled:site-cycle:${month}` },
          idempotencyKey: `cycle:${month}:bundle`,
          maxAttempts: 2,
        });
        push("bundle", "monthly", "queued", `month ${month}`);
      } catch (error) {
        push("bundle", "monthly", "failed", error instanceof Error ? error.message.slice(0, 160) : "failed");
      }
    }

    results.push({ siteId: site.id, domain: site.domain, week, month, stages });
  }

  return results;
}
