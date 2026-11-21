/**
 * Prove the research loop on one site, without paid provider calls.
 *
 *   npx tsx scripts/smoke-research-loop.ts --site <siteId>
 *   npx tsx scripts/smoke-research-loop.ts --site <siteId> --apply
 *
 * Steps, each reported before and after:
 *   1. knowledge from the crawl (or a fresh crawl)
 *   2. research run with the free providers (news by default)
 *   3. findings -> funnel evidence -> opportunities (why leg)
 *   4. topic map and taxonomy from measured demand *and research forms*
 *   5. the monthly bundle plan, dry-run: would the cap buy the claimed forms?
 *
 * No DataForSEO call, no bundle execution, no join spend. This is the tool for
 * proving the loop on a disposable tenant before the scheduled cycle runs it.
 */

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

import { ensureTenantAnalysis } from "@/lib/tenants/analysis";
import { createResearchRun } from "@/lib/research/service";
import { runResearchRun } from "@/lib/research/runner";
import { runSiteCrawl } from "@/lib/crawler/engine";
import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { runTopicMap } from "@/lib/research/topic-map-run";
import { runMonthlyBundle } from "@/lib/research/monthly-bundle";
import { demandCandidateSince, researchCandidateQueries } from "@/lib/research/demand-candidates";
import { loadTopicTaxonomy } from "@/lib/research/topic-taxonomy";
import { loadTaxonomyReview, taxonomyNeedsReview } from "@/lib/research/taxonomy-review";
import { resolveSiteContext } from "@/lib/site/context";

loadEnvConfig(process.cwd());

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function value(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function state(db: PrismaClient, siteId: string, projectId: string) {
  const [knowledge, crawls, runs, findings, opportunities] = await Promise.all([
    db.businessKnowledgeDocument.findUnique({
      where: { projectId },
      select: { revision: true, acceptedRevision: true, revisions: { orderBy: { revision: "desc" }, take: 1, select: { fields: true } } },
    }),
    db.crawl.count({ where: { siteId, status: "COMPLETED" } }),
    db.researchRun.count({ where: { siteId } }),
    db.researchFinding.count({ where: { run: { siteId } } }),
    db.opportunity.groupBy({
      by: ["type", "evidenceCompleteness"],
      where: { projectId },
      _count: { _all: true },
    }),
  ]);
  return {
    knowledge: knowledge ? `revision ${knowledge.acceptedRevision ?? knowledge.revision} (${Object.keys(knowledge.revisions[0]?.fields ?? {}).length} fields)` : "absent",
    completedCrawls: crawls,
    researchRuns: runs,
    findings,
    opportunities: opportunities.reduce<Record<string, number>>((acc, row) => {
      acc[`${row.type}/${row.evidenceCompleteness}`] = row._count._all;
      return acc;
    }, {}),
  };
}

async function main() {
  const db = new PrismaClient();
  const siteId = value("--site");
  const apply = flag("--apply");
  if (!siteId) throw new Error("--site <siteId> is required");
  const requested = (value("--providers") ?? "news").split(",").map((entry) => entry.trim()).filter(Boolean);
  const providers = requested.filter((entry): entry is "reddit" | "news" | "web" | "competitor" =>
    entry === "reddit" || entry === "news" || entry === "web" || entry === "competitor"
  );
  const now = new Date();
  const month = monthKey(now);

  try {
    const site = await db.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { id: true, domain: true, projectId: true, userId: true, retiredAt: true },
    });
    if (!site.projectId) throw new Error(`${site.domain} is not attached to a project`);
    const projectId = site.projectId;
    process.stdout.write(`\n${site.domain}  ${month}  ${apply ? "apply" : "read-only"}\n`);

    process.stdout.write("\nbefore\n");
    process.stdout.write(`${JSON.stringify(await state(db, site.id, projectId), null, 2)}\n`);
    if (!apply) {
      process.stdout.write("\nread-only: pass --apply to run the loop. Nothing was written.\n");
      return;
    }

    // 1. Bootstrap: knowledge from the site's own pages, then the language and
    //    topics derived from it. This is the same bootstrap the site cycle runs.
    const bootstrap = await ensureTenantAnalysis(db, site.id, {
      apply: true,
      bootstrapOnly: true,
      skipResearch: true,
      requestedBy: "smoke-research-loop",
      now,
    });
    const knowledgeStep = bootstrap.steps.find((step) => step.step === "business-knowledge");
    process.stdout.write(`\nknowledge: ${knowledgeStep?.status ?? "unknown"} — ${knowledgeStep?.detail ?? "no detail"}\n`);
    const profile = await db.siteProfile.findUnique({ where: { siteId: site.id }, select: { topics: true, audience: true } });
    const topics = Array.isArray(profile?.topics)
      ? (profile.topics as unknown[]).filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0)
      : [];
    process.stdout.write(`topics: ${topics.length > 0 ? topics.join(" · ") : "none derived"}\n`);
    if (topics.length === 0) throw new Error("no research topics were derived; the run would have nothing to ask about");

    // 2. Crawl, when asked. The cycle crawls weekly; a fresh crawl is reused.
    if (flag("--crawl")) {
      const crawl = await db.crawl.create({ data: { siteId: site.id, status: "PENDING", maxPages: 200 }, select: { id: true } });
      await runSiteCrawl(site.id, site.domain, 200, crawl.id);
      await refreshFunnelForSite(db, site.id, { detectedBy: "smoke-research-loop" });
      process.stdout.write(`crawl: ${crawl.id} completed and projected into the funnel\n`);
    }

    // 3. Research with free providers only (news by default).
    const context = await resolveSiteContext(db, site.id);
    const run = await createResearchRun(
      site.id,
      {
        title: `Smoke research — ${month}`,
        language: context.language,
        audience: profile?.audience && typeof profile.audience === "string" ? profile.audience : undefined,
        market: context.market ?? undefined,
        kind: "MARKET",
        trigger: "MANUAL",
        topics,
        questions: [],
        recencyDays: 90,
        providers,
      },
      site.userId ?? "smoke-research-loop"
    );
    await runResearchRun(run.id);
    const completed = await db.researchRun.findUnique({
      where: { id: run.id },
      select: { status: true, sourceCount: true, findingCount: true, errorCode: true },
    });
    process.stdout.write(`research: run ${run.id} ${completed?.status ?? "unknown"}, ${completed?.sourceCount ?? 0} source(s), ${completed?.findingCount ?? 0} finding(s)${completed?.errorCode ? ` (${completed.errorCode})` : ""}\n`);

    // 4. Findings reach the board without any paid measurement.
    await refreshFunnelForSite(db, site.id, { detectedBy: "smoke-research-loop" });
    process.stdout.write("funnel: refreshed from stored evidence\n");

    // 5. Taxonomy from measured demand and the research forms.
    const map = await runTopicMap(db, {
      siteId: site.id,
      month,
      mode: "execute",
      approval: `auto:smoke:${month}`,
      ai: false,
      refreshJobMap: true,
      now,
    });
    process.stdout.write(`topic map: ${map.status}, run ${map.runId}, ${map.taxonomy?.topics.length ?? 0} topic(s)\n`);
    for (const warning of map.warnings) process.stdout.write(`  note: ${warning}\n`);

    // 6. The plan the bundle would buy, without spending.
    const bundle = await runMonthlyBundle(db, { siteId: site.id, month, mode: "dry-run", now });
    const plan = bundle.plan;
    process.stdout.write(`\nbundle plan (dry run): ${plan.selected.keywordQueries.length} keyword queries, ${plan.selected.serpQueries.length} SERP snapshots, ${plan.selected.aeoQuestions.length} AEO questions\n`);
    process.stdout.write(`  research forms: ${plan.coverage.researchCandidateQueries} observed, ${plan.coverage.researchCandidatesClaimed} claimed, ${plan.coverage.researchCandidatesReserved} reserved, ${plan.coverage.researchCandidatesUnclaimed} unclaimed\n`);
    process.stdout.write(`  keyword queries: ${plan.selected.keywordQueries.slice(0, 12).join(" · ")}\n`);

    // 7. What the site now has.
    const taxonomy = await loadTopicTaxonomy(db, site.id);
    const review = await loadTaxonomyReview(db, site.id);
    const forms = await researchCandidateQueries(db, {
      projectId,
      siteId: site.id,
      since: demandCandidateSince(now),
      taxonomy,
      limit: 50,
    });
    process.stdout.write(`\nafter\n${JSON.stringify(await state(db, site.id, projectId), null, 2)}\n`);
    process.stdout.write(`taxonomy: ${taxonomy?.topics.length ?? 0} topic(s), auto-approval ${review?.approvedBy ?? "none"}, review needed ${taxonomyNeedsReview(taxonomy, review)}\n`);
    process.stdout.write(`research forms: ${forms.candidates.length} claimed, ${forms.unclaimed.length} unclaimed\n`);
    if (forms.candidates.length > 0) process.stdout.write(`  claimed: ${forms.candidates.slice(0, 12).join(" · ")}\n`);
    if (forms.unclaimed.length > 0) process.stdout.write(`  unclaimed: ${forms.unclaimed.slice(0, 12).join(" · ")}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
