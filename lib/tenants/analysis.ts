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
  step: "site-records" | "site-context" | "topics" | "business-knowledge" | "crawl" | "research" | "joins" | "funnel";
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

/**
 * Topics for a tenant that has none, taken from what the site says it does.
 *
 * The other tenants had topics because a human wrote them; a new tenant should not
 * need that to be analysed. Services are the site's own words, so they are a
 * defensible starting query set, and the owner can replace them.
 */
/**
 * A place name worth putting in a search phrase.
 *
 * `location` can be a street address ("Calle Juan de la Barrera"), and appending
 * it produced research topics like "property listings Calle Juan de la Barrera" —
 * a phrase nobody searches, in a market the business does not serve. Only a
 * locality, region or country is usable; a street is not.
 */
const STREET_PATTERN = /\b(calle|street|st\.|avenue|ave\.|av\.|road|rd\.|boulevard|blvd|rue|via|plaza|paseo|carretera|highway|suite|floor|unit)\b|\d/i;

export function placeToken(value: string | null | undefined): string | null {
  if (!value) return null;
  // "Playa del Carmen, Quintana Roo, Mexico" -> "Playa del Carmen".
  const first = value.split(",")[0]?.trim() ?? "";
  if (!first || first.length > 40) return null;
  if (STREET_PATTERN.test(first)) return null;
  return first;
}

/**
 * Research topics from the site's own evidence.
 *
 * Services first (the offers a customer searches for), then the queries Search
 * Console already shows people using, and only then differentiators. A tenant with
 * no business knowledge is not blocked: its observed queries are the best
 * available statement of what it is for.
 */
async function deriveTopics(
  db: PrismaClient,
  projectId: string | null,
  siteId: string,
  context: { language: string; location: string | null; market: string | null }
): Promise<string[]> {
  if (!projectId) return [];
  const document = await db.businessKnowledgeDocument.findUnique({
    where: { projectId },
    select: { revision: true, acceptedRevision: true, revisions: { orderBy: { revision: "desc" }, take: 1, select: { fields: true } } },
  });
  const fields = (document?.revisions[0]?.fields ?? {}) as Record<string, { value?: unknown }>;
  const list = (key: string): string[] => {
    const value = fields[key]?.value;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
  };
  const services = list("services").slice(0, 5);
  const differentiators = list("differentiators").slice(0, 3);

  const place = placeToken(context.location) ?? placeToken(context.market);
  const withPlace = (phrase: string): string => {
    const clean = phrase.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!place) return clean;
    return clean.toLowerCase().includes(place.toLowerCase()) ? clean : `${clean} ${place}`;
  };

  let candidates = services.map(withPlace);
  if (candidates.length === 0) {
    // No declared services: use what people already search for, which is the
    // only evidence of the site's subject that does not depend on configuration.
    const observed = await db.keyword.findMany({
      where: { siteId, query: { not: "" } },
      orderBy: { impressions: "desc" },
      take: 40,
      select: { query: true, impressions: true },
    });
    const seen = new Set<string>();
    for (const row of observed) {
      const phrase = row.query.trim();
      if (phrase.length < 4 || seen.has(phrase.toLowerCase())) continue;
      seen.add(phrase.toLowerCase());
      candidates.push(phrase);
      if (candidates.length >= 5) break;
    }
  }
  if (candidates.length === 0) candidates = differentiators.map(withPlace);

  const topics = candidates.slice(0, 5);
  if (topics.length === 0) return [];
  await db.siteProfile.upsert({
    where: { siteId },
    create: { siteId, projectId, language: context.language, topics },
    update: { topics },
  });
  return topics;
}

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

  // 5. A crawl that actually covered the site. "COMPLETED" only means the job
  //    stopped; a cap or a challenge can leave most of the site unobserved.
  const crawl = await db.crawl.findFirst({
    where: { siteId: site.id, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, finishedAt: true, pagesFound: true, maxPages: true },
  });
  if (!crawl) {
    steps.push(step({ step: "crawl", status: "missing", detail: "no completed crawl" }));
  } else {
    const capped = crawl.maxPages > 0 && crawl.pagesFound >= crawl.maxPages;
    steps.push(step({
      step: "crawl",
      status: capped ? "missing" : "ok",
      detail: capped
        ? `${crawl.pagesFound} pages reached the ${crawl.maxPages}-page cap: coverage is incomplete`
        : `${crawl.pagesFound} pages crawled ${crawl.finishedAt?.toISOString().slice(0, 10) ?? ""}`,
    }));
  }

  // 6. A research run inside the cadence window.
  const cadence = normalizeResearchCadence(site.researchPolicy?.cadence);
  const lastRun = await db.researchRun.findFirst({
    where: { siteId: site.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, createdAt: true, findingCount: true, sourceCount: true, errorCode: true },
  });
  const fresh = (() => {
    // A failed run is not research. Treating it as fresh let a tenant report READY
    // with zero findings, which is the opposite of what the report is for.
    if (!lastRun || lastRun.status === "FAILED") return false;
    if (cadence === "manual" || (CADENCE_DAYS[cadence] ?? 0) === 0) return true;
    const { start } = researchCadenceWindow(cadence, new Date(), "UTC");
    return lastRun.createdAt.getTime() >= start.getTime();
  })();
  // A run that collected nothing and produced nothing is not research. Reporting
  // it as OK let a tenant show READY with an empty board and a PARTIAL run whose
  // paid collection had been refused.
  const runIsEmpty = lastRun ? lastRun.sourceCount === 0 && lastRun.findingCount === 0 : false;
  steps.push(!lastRun
    ? step({ step: "research", status: "missing", detail: "no research run has ever completed" })
    : lastRun.status === "FAILED"
      ? step({ step: "research", status: "missing", detail: `last run failed: ${lastRun.errorCode ?? "unknown"}` })
    : runIsEmpty
      ? step({ step: "research", status: "missing", detail: `last run ${lastRun.status} with no sources and no findings: ${lastRun.errorCode ?? "no reason recorded"}` })
      : lastRun.status === "PARTIAL"
        ? step({ step: "research", status: "missing", detail: `last run PARTIAL (${lastRun.sourceCount} source(s), ${lastRun.findingCount} finding(s)): ${lastRun.errorCode ?? "incomplete"}` })
    : fresh
      ? step({ step: "research", status: "ok", detail: `${lastRun.status}, ${lastRun.findingCount} finding(s), ${lastRun.createdAt.toISOString().slice(0, 10)}` })
      : step({ step: "research", status: "missing", detail: `last run ${lastRun.createdAt.toISOString().slice(0, 10)} is outside the ${cadence} window` }));

  // 7. Opportunities that have a why but no how are waiting for the join.
  const unjoined = site.projectId
    ? await db.opportunity.count({
        where: { projectId: site.projectId, status: "detected", evidenceCompleteness: { in: ["why", "none"] } },
      })
    : 0;
  steps.push(unjoined === 0
    ? step({ step: "joins", status: "ok", detail: "no opportunity is waiting for a how leg" })
    : step({ step: "joins", status: "missing", detail: `${unjoined} opportunity(ies) have a why leg and no how leg` }));

  // 8. The board itself.
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

  let context = await resolveSiteContext(db, site.id).catch(() => null);
  const knowledgeMissing = steps.find((entry) => entry.step === "business-knowledge")?.status === "missing";
  const languageMissing = !context;

  // Bootstrap: a site with no profile and no knowledge document is not a broken
  // tenant, it is an unconfigured one. Its own pages are the only source for its
  // language and topics, so extraction runs before anything needs them.
  let extraction: Awaited<ReturnType<typeof extractBusinessKnowledgeFromSite>> | null = null;
  if ((knowledgeMissing || languageMissing) && site.projectId) {
    try {
      extraction = await extractBusinessKnowledgeFromSite(db, { projectId: site.projectId });
      replace(step({
        step: "business-knowledge",
        status: "fixed",
        detail: `extracted ${extraction.extracted.length} field(s) from ${extraction.pagesRead} page(s), revision ${extraction.revision}`,
      }));
    } catch (error) {
      replace(step({
        step: "business-knowledge",
        status: "failed",
        detail: `extraction failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
      }));
    }
  }

  // The pages' own language, persisted so it is stable and visible to the owner.
  if (languageMissing && extraction?.contentLanguage) {
    await db.siteProfile.upsert({
      where: { siteId: site.id },
      create: { siteId: site.id, projectId: site.projectId, language: extraction.contentLanguage, topics: [] },
      update: { language: extraction.contentLanguage },
    });
    context = await resolveSiteContext(db, site.id).catch(() => null);
    replace(step({
      step: "site-context",
      status: "fixed",
      detail: `language ${extraction.contentLanguage} detected from the site's own pages`,
    }));
  }
  if (!context) return { ...before, steps };

  // Topics: derived from the extracted services rather than typed in by hand, so an
  // unconfigured tenant gets analysed on the same schedule as a configured one.
  const existingTopics = Array.isArray(site.siteProfile?.topics)
    ? site.siteProfile.topics.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0)
    : [];
  if (existingTopics.length === 0) {
    const derived = await deriveTopics(db, site.projectId, site.id, context);
    if (derived.length > 0) {
      replace(step({ step: "topics", status: "fixed", detail: `${derived.length} topic(s) derived from the site's own services` }));
    }
  }

  // Research: queue a run when the last one is outside the cadence window.
  if (steps.find((entry) => entry.step === "research")?.status === "missing" && site.projectId) {
    // Read the profile again: the bootstrap above may have created it in this same
    // call, and the snapshot taken at the top predates the derived topics. A run
    // created from that snapshot has no topics and fails immediately.
    const freshProfile = await db.siteProfile.findUnique({
      where: { siteId: site.id },
      select: { topics: true, audience: true },
    });
    const topics = Array.isArray(freshProfile?.topics)
      ? freshProfile.topics.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0)
      : [];
    // A site can be provisioned without an owner record (the connector creates
    // some of them), and the scheduled pass already uses a system identity. Failing
    // here made a tenant's research depend on a user row that has nothing to do
    // with the analysis.
    const requestedBy = opts.requestedBy ?? site.userId ?? "tenant-pipeline";
    // One run per cadence window, keyed like the scheduler's, so repeated pipeline
    // passes cannot queue a run each time. That also makes it a scheduled run for
    // the count guard: it is bounded by construction, not by a run counter.
    const cadence = normalizeResearchCadence((await db.researchPolicy.findUnique({ where: { siteId: site.id }, select: { cadence: true } }))?.cadence);
    const windowKey = cadence === "manual" ? `manual:${site.id}` : researchCadenceWindow(cadence, opts.now ?? new Date(), "UTC").key;
    try {
      const run = await createResearchRun(site.id, {
        title: `${site.domain} — ${context.audienceCountry ?? context.country ?? "market"} analysis`,
        kind: "MARKET",
        trigger: "SCHEDULED",
        topics,
        audience: typeof freshProfile?.audience === "string" ? freshProfile.audience : undefined,
        market: context.market ?? undefined,
        language: context.language,
        questions: [],
        recencyDays: 180,
        providers: ["reddit", "news", "competitor"],
      }, requestedBy, windowKey);
      await enqueueJob({
        projectId: site.projectId,
        siteId: site.id,
        kind: "RESEARCH_RUN",
        payload: { researchRunId: run.id },
        idempotencyKey: `research-run:${run.id}`,
        maxAttempts: 2,
      });
      // An existing run for this window (including a failed one) is not re-queued:
      // the window is the retry unit, so a failure waits for the next one instead
      // of looping against the budget.
      replace(step({
        step: "research",
        status: run.status === "FAILED" ? "failed" : "pending",
        detail: run.status === "FAILED"
          ? `run ${run.id} failed this window: ${run.errorCode ?? "unknown"}`
          : `queued run ${run.id}`,
      }));
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
