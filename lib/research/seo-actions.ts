import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getContentActionPlan } from "@/lib/ai-seo/content-plan";
import { createResearchAction } from "@/lib/research/service";
import { isSupersededByExternalAuthority } from "@/lib/research/execution-authority";
import {
  editorialFingerprint,
  reviewSeoOpportunity,
  type EditorialCandidatePage,
  type EditorialReview,
} from "@/lib/editorial/review";
import { isDurableEditorialTarget } from "@/lib/editorial/targets";
import { syncCrawlIssuesToActions } from "@/lib/research/crawl-actions";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function existingEditorial(evidence: unknown, fingerprint: string): EditorialReview | null {
  const editorial = record(record(evidence).editorial);
  if (editorial.fingerprint !== fingerprint) return null;
  if (typeof editorial.decision !== "string" || typeof editorial.title !== "string") return null;
  return editorial as unknown as EditorialReview;
}

/**
 * Persist the GSC/crawl opportunity plan through the editorial layer before it
 * reaches Work. The editorial decision can narrow an action to a section, move
 * it to a new article, or dismiss a bad page/query match.
 */
export async function syncSeoOpportunitiesToActions(siteId: string) {
  if (await isSupersededByExternalAuthority(siteId)) {
    return {
      created: 0, updated: 0, dismissed: 0, existing: 0, total: 0,
      skipped: "superseded_by_external_authority",
    };
  }

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, domain: true },
  });
  if (!site) return { created: 0, updated: 0, dismissed: 0, existing: 0, total: 0 };

  const plan = await getContentActionPlan(siteId, site.domain);
  const latestCrawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  const landingPages: EditorialCandidatePage[] = latestCrawl
    ? (await db.auditPage.findMany({
        where: { crawlId: latestCrawl.id, statusCode: 200 },
        orderBy: { contentScore: "desc" },
        take: 200,
        select: { url: true, title: true },
      }))
      .filter((page) => isDurableEditorialTarget(page.url))
      .map((page) => ({ url: page.url, title: page.title ?? "" }))
    : [];

  const current = await db.researchAction.findMany({
    where: { siteId, source: "seo_opportunity" },
    select: {
      id: true,
      status: true,
      priority: true,
      evidence: true,
    },
  });
  const byPlanId = new Map<string, typeof current[number]>();
  for (const action of current) {
    const planId = record(action.evidence).action_id;
    if (typeof planId === "string") byPlanId.set(planId, action);
  }

  let created = 0;
  let updated = 0;
  let dismissed = 0;
  let existing = 0;

  for (const action of plan.actions) {
    const previous = byPlanId.get(action.id) ?? null;
    if (previous && ["DISMISSED", "VERIFIED", "FAILED"].includes(previous.status)) {
      existing += 1;
      continue;
    }

    const fingerprint = editorialFingerprint(action, landingPages);
    const review = existingEditorial(previous?.evidence, fingerprint)
      ?? await reviewSeoOpportunity(action, { landingPages });

    if (review.decision === "dismiss") {
      if (previous && previous.status === "PROPOSED") {
        await db.researchAction.update({
          where: { id: previous.id },
          data: { status: "DISMISSED" },
        });
        dismissed += 1;
      } else {
        existing += 1;
      }
      continue;
    }

    const targetUrl = review.decision === "new_article"
      ? null
      : review.targetUrl ?? action.targetUrl;
    const kind = review.decision === "new_article"
      ? "create_article"
      : review.decision === "add_section"
        ? "add_section"
        : review.decision === "metadata_only"
          ? "rewrite_metadata"
          : action.kind;
    const format = review.decision === "new_article"
      ? "article"
      : review.decision === "metadata_only"
        ? "metadata"
        : "page_update";

    const evidence = {
      ...record(previous?.evidence),
      action_id: action.id,
      signals: action.signals,
      intent: action.intent,
      expected_clicks: action.expectedClicks,
      metrics: action.evidence,
      page: action.page,
      editorial: review,
    };

    if (previous) {
      await db.researchAction.update({
        where: { id: previous.id },
        data: {
          kind,
          format,
          title: review.title,
          primaryQuery: action.primaryQuery || null,
          targetUrl,
          recommendation: review.scope,
          evidence: json(evidence),
          priority: Math.max(previous.priority, action.score),
        },
      });
      updated += 1;
      continue;
    }

    const result = await createResearchAction(
      siteId,
      {
        source: "seo_opportunity",
        kind,
        format,
        title: review.title,
        primaryQuery: action.primaryQuery || undefined,
        targetUrl: targetUrl || undefined,
        recommendation: review.scope,
        evidence,
        priority: action.score,
        automationMode: "MANUAL",
        dedupeKey: `seo:${action.id}`,
      },
      "seo-engine",
    );
    if (result.created) created += 1;
    else existing += 1;
  }

  let crawl;
  try {
    crawl = await syncCrawlIssuesToActions(siteId);
  } catch (error) {
    console.error("Crawl action sync error:", error);
    crawl = { error: error instanceof Error ? error.message : "crawl action sync failed" };
  }

  return { created, updated, dismissed, existing, total: plan.actions.length, crawl };
}
