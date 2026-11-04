import type { PrismaClient } from "@prisma/client";

import { buildJoinCollectors } from "@/lib/dataforseo/join-collectors";
import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { runJoinFollowUps } from "@/lib/funnel/join-runner";
import { enqueueJob } from "@/lib/jobs/queue";
import { extractBusinessKnowledgeFromSite } from "@/lib/projects/business-knowledge-extract";
import { normalizeResearchCadence } from "@/lib/research/policy";
import { researchCadenceWindow } from "@/lib/research/schedule";
import { createResearchRun } from "@/lib/research/service";
import { MissingSiteContextError, resolveSiteContext } from "@/lib/site/context";

/**
 * What "a tenant has been analysed" means, defined once.
 *
 * Every step below used to be something an operator did by hand, per tenant, in a
 * script: extract business knowledge, create a research run, run the joins,
 * refresh the funnel. So a tenant was analysed only if someone remembered, and the
 * difference between a tenant that looked complete and one that looked thin was
 * mostly which scripts had been run for it.
 *
 * This module is the definition. The worker, the CLI and the API all call it, so a
 * new tenant is analysed by the same steps as the first one, and a gap is reported
 * rather than discovered months later.
 */

export type TenantStepStatus = "ok" | "missing" | "blocked" | "fixed" | "pending" | "failed";

export type TenantStep = {
  step: "site-records" | "site-context" | "topics" | "business-knowledge" | "research" | "joins" | "funnel";
  status: TenantStepStatus;
  detail: string;
};

export type TenantAnalysis = {
  siteId: string;
  domain: string;
  projectId: string | null;
  /** True when nothing is missing or blocked: the tenant has a complete analysis. */
  ready: boolean;
  steps: TenantStep[];
};

export type TenantAnalysisOptions = {
  /** Perform the fixes that can be performed now. Without it, this is a read. */
  apply?: boolean;
  /** Ceiling for the join's paid collectors. */
  maxJoinSpendMicros?: number;
  /** Who triggered the work, recorded on created runs. */
  requestedBy?: string | null;
  now?: Date;
};

const CADENCE_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 31, manual: 0 };

function step(entry: TenantStep): TenantStep {
  return entry;
}

export async function inspectTenant(db: PrismaClient, siteId: string): Promise<TenantAnalysis> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      domain: true,
      projectId: true,
      userId: true,
      retiredAt: true,
      siteProfile: { select: { topics: true, audience: true, language: true, constraints: true } },
      researchPolicy: { select: { enabled: true, cadence: true, providers: true, recencyDays: true } },
    },
  });
  if (!site) throw new Error(`Site ${siteId} not found`);

  const steps: TenantStep[] = [];

  if (site.retiredAt) {
    return {
      siteId: site.id,
      domain: site.domain,
      projectId: site.projectId,
      ready: true,
      steps: [step({
        step: "site-records",
        status: "ok",
        detail: `retired ${site.retiredAt.toISOString().slice(0, 10)}; kept for audit, not analysed`,
      })],
    };
  }

  // 1. One site record per domain. Two rows split a tenant's history: the crawl
  //    lands on one, research on the other, and every report is half a tenant.
  const duplicates = await db.site.count({
    // A retired tombstone is not a competing record: it is kept for audit and
    // excluded from analysis, so it does not split this tenant's history.
    where: { domain: site.domain, id: { not: site.id }, retiredAt: null },
  });
  steps.push(duplicates > 0
    ? step({ step: "site-records", status: "blocked", detail: `${duplicates} other site record(s) share ${site.domain}; history is split` })
    : step({ step: "site-records", status: "ok", detail: "one site record" }));

  // 2. The site's own facts: language, audience market, location.
  const context = await resolveSiteContext(db, site.id).catch((error) => {
    if (error instanceof MissingSiteContextError) return null;
    throw error;
  });
  if (!context) {
    steps.push(step({ step: "site-context", status: "blocked", detail: "no language: set it on the site profile" }));
  } else if (!context.audienceCountry) {
    // A local business sells where it sits, so the business market is a defensible
    // default and is recorded as the fallback. It only blocks when neither is known.
    steps.push(context.country
      ? step({
          step: "site-context",
          status: "ok",
          detail: `${context.language}/${context.country} (audience market unset; measuring the business market)`,
        })
      : step({
          step: "site-context",
          status: "missing",
          detail: "neither an audience market nor a business market is set",
        }));
  } else {
    steps.push(step({
      step: "site-context",
      status: "ok",
      detail: `${context.language}/${context.audienceCountry} (audience), business in ${context.country ?? "unknown"}`,
    }));
  }

  // 3. Research needs topics; without them a run has nothing to ask about.
  const topics = Array.isArray(site.siteProfile?.topics)
    ? site.siteProfile.topics.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0)
    : [];
  steps.push(topics.length > 0
    ? step({ step: "topics", status: "ok", detail: `${topics.length} configured topic(s)` })
    : step({ step: "topics", status: "blocked", detail: "no research topics: the run has nothing to ask about" }));

  // 4. Business knowledge: the why-leg's business facts.
  const knowledge = site.projectId
    ? await db.businessKnowledgeDocument.findUnique({
        where: { projectId: site.projectId },
        select: { revision: true, acceptedRevision: true },
      })
    : null;
  steps.push(knowledge
    ? step({ step: "business-knowledge", status: "ok", detail: `revision ${knowledge.acceptedRevision ?? knowledge.revision}${knowledge.acceptedRevision ? " (accepted)" : " (unverified)"}` })
    : step({ step: "business-knowledge", status: "missing", detail: "no knowledge document: the why-leg has no business facts" }));

  // 5. A research run inside the cadence window.
  const cadence = normalizeResearchCadence(site.researchPolicy?.cadence);
  const lastRun = await db.researchRun.findFirst({
    where: { siteId: site.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, createdAt: true, findingCount: true },
  });
  const fresh = (() => {
    if (!lastRun) return false;
    if (cadence === "manual" || (CADENCE_DAYS[cadence] ?? 0) === 0) return true;
    const { start } = researchCadenceWindow(cadence, new Date(), "UTC");
    return lastRun.createdAt.getTime() >= start.getTime();
  })();
  steps.push(!lastRun
    ? step({ step: "research", status: "missing", detail: "no research run has ever completed" })
    : fresh
      ? step({ step: "research", status: "ok", detail: `${lastRun.status}, ${lastRun.findingCount} finding(s), ${lastRun.createdAt.toISOString().slice(0, 10)}` })
      : step({ step: "research", status: "missing", detail: `last run ${lastRun.createdAt.toISOString().slice(0, 10)} is outside the ${cadence} window` }));

  // 6. Opportunities that have a why but no how are waiting for the join.
  const unjoined = site.projectId
    ? await db.opportunity.count({
        where: { projectId: site.projectId, status: "detected", evidenceCompleteness: { in: ["why", "none"] } },
      })
    : 0;
  steps.push(unjoined === 0
    ? step({ step: "joins", status: "ok", detail: "no opportunity is waiting for a how leg" })
    : step({ step: "joins", status: "missing", detail: `${unjoined} opportunity(ies) have a why leg and no how leg` }));

  // 7. The board itself.
  const detected = site.projectId
    ? await db.opportunity.count({ where: { projectId: site.projectId, status: "detected" } })
    : 0;
  steps.push(detected > 0
    ? step({ step: "funnel", status: "ok", detail: `${detected} detected opportunity(ies)` })
    : step({ step: "funnel", status: "missing", detail: "no detected opportunities: run the crawl" }));

  return {
    siteId: site.id,
    domain: site.domain,
    projectId: site.projectId,
    ready: steps.every((entry) => entry.status === "ok" || entry.status === "fixed"),
    steps,
  };
}

/**
 * Bring the tenant to a complete analysis, and report what could not be fixed yet.
 *
 * Idempotent: running it twice changes nothing the second time. Steps that need a
 * job (research) are queued and reported as `pending`; the caller re-runs the
 * pipeline after the job completes rather than waiting here.
 */
export async function ensureTenantAnalysis(
  db: PrismaClient,
  siteId: string,
  opts: TenantAnalysisOptions = {}
): Promise<TenantAnalysis> {
  const before = await inspectTenant(db, siteId);
  if (!opts.apply) return before;

  const site = await db.site.findUniqueOrThrow({
    where: { id: siteId },
    select: { id: true, domain: true, projectId: true, userId: true, siteProfile: { select: { topics: true, audience: true } } },
  });
  const steps = [...before.steps];
  const replace = (entry: TenantStep) => {
    const index = steps.findIndex((existing) => existing.step === entry.step);
    if (index >= 0) steps[index] = entry;
  };

  const context = await resolveSiteContext(db, site.id).catch(() => null);
  if (!context) return { ...before, steps };

  // Business knowledge: extract when there is none. This was a script run for one
  // tenant; every tenant now gets it on the same condition.
  if (steps.find((entry) => entry.step === "business-knowledge")?.status === "missing" && site.projectId) {
    try {
      const result = await extractBusinessKnowledgeFromSite(db, { projectId: site.projectId });
      replace(step({
        step: "business-knowledge",
        status: "fixed",
        detail: `extracted ${result.extracted.length} field(s) from ${result.pagesRead} page(s), revision ${result.revision}`,
      }));
    } catch (error) {
      replace(step({
        step: "business-knowledge",
        status: "failed",
        detail: `extraction failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
      }));
    }
  }

  // Research: queue a run when the last one is outside the cadence window.
  if (steps.find((entry) => entry.step === "research")?.status === "missing" && site.projectId) {
    const topics = Array.isArray(site.siteProfile?.topics)
      ? site.siteProfile.topics.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0)
      : [];
    const requestedBy = opts.requestedBy ?? site.userId;
    if (!requestedBy) {
      replace(step({ step: "research", status: "failed", detail: "no owner on the site: a research run needs a requester" }));
    } else try {
      const run = await createResearchRun(site.id, {
        title: `${site.domain} — ${context.audienceCountry ?? context.country ?? "market"} analysis`,
        kind: "MARKET",
        trigger: "MANUAL",
        topics,
        audience: typeof site.siteProfile?.audience === "string" ? site.siteProfile.audience : undefined,
        market: context.market ?? undefined,
        language: context.language,
        questions: [],
        recencyDays: 180,
        providers: ["reddit", "news", "competitor"],
      }, requestedBy);
      await enqueueJob({
        projectId: site.projectId,
        siteId: site.id,
        kind: "RESEARCH_RUN",
        payload: { researchRunId: run.id },
        idempotencyKey: `research-run:${run.id}`,
        maxAttempts: 2,
      });
      replace(step({ step: "research", status: "pending", detail: `queued run ${run.id}` }));
    } catch (error) {
      replace(step({
        step: "research",
        status: "failed",
        detail: `could not queue a run: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
      }));
    }
  }

  // Joins: attach the how leg to every why-only opportunity.
  if (steps.find((entry) => entry.step === "joins")?.status === "missing" && site.projectId) {
    const setup = await buildJoinCollectors(db, {
      projectId: site.projectId,
      siteId: site.id,
      domain: site.domain,
      language: context.language,
      country: context.audienceCountry ?? context.country,
    });
    try {
      const result = await runJoinFollowUps(db, {
        projectId: site.projectId,
        siteId: site.id,
        maxSpendMicros: opts.maxJoinSpendMicros ?? 200_000,
        collectors: setup?.collectors,
      });
      replace(step({
        step: "joins",
        status: result.joined.length > 0 ? "fixed" : "ok",
        detail: `${result.joined.length} joined, ${result.skipped.length} skipped, $${(result.spentMicros / 1e6).toFixed(3)}`,
      }));
    } catch (error) {
      replace(step({
        step: "joins",
        status: "failed",
        detail: `join failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
      }));
    }
  }

  if (site.projectId) {
    await refreshFunnelForSite(db, site.id, { detectedBy: "tenant-analysis" });
  }

  const detected = site.projectId
    ? await db.opportunity.count({ where: { projectId: site.projectId, status: "detected" } })
    : 0;
  replace(step({
    step: "funnel",
    status: detected > 0 ? "ok" : "missing",
    detail: `${detected} detected opportunity(ies)`,
  }));

  return {
    ...before,
    steps,
    ready: steps.every((entry) => entry.status === "ok" || entry.status === "fixed"),
  };
}
