import type { ContentAction } from "@/lib/ai-seo/action-plan";
import { classifySearchIntent } from "@/lib/ai-seo/action-plan";
import { db } from "@/lib/db";
import {
  deterministicEditorialReview,
  type EditorialCandidatePage,
  type EditorialReview,
} from "@/lib/editorial/review";
import { classifyEditorialTarget, isDurableEditorialTarget } from "@/lib/editorial/targets";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function getDurableLandingPages(siteId: string): Promise<EditorialCandidatePage[]> {
  const latestCrawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  if (!latestCrawl) return [];
  const pages = await db.auditPage.findMany({
    where: { crawlId: latestCrawl.id, statusCode: 200 },
    orderBy: { contentScore: "desc" },
    take: 200,
    select: { url: true, title: true },
  });
  return pages
    .filter((page) => isDurableEditorialTarget(page.url))
    .map((page) => ({ url: page.url, title: page.title ?? "" }));
}

function asContentAction(action: {
  id: string;
  kind: string;
  format: string | null;
  title: string;
  primaryQuery: string | null;
  targetUrl: string | null;
  recommendation: string;
  priority: number;
  evidence: unknown;
}): ContentAction {
  return {
    id: action.id,
    kind: action.kind as ContentAction["kind"],
    format: (action.format === "article" || action.format === "metadata" ? action.format : "page_update") as ContentAction["format"],
    title: action.title,
    primaryQuery: action.primaryQuery ?? "",
    targetUrl: action.targetUrl,
    intent: classifySearchIntent(action.primaryQuery ?? action.title),
    signals: [],
    evidence: record(action.evidence) as ContentAction["evidence"],
    page: null,
    impact: action.priority,
    confidence: action.priority,
    effort: 40,
    score: action.priority,
    expectedClicks: 0,
    recommendedAction: action.recommendation,
  };
}

function editorialEvidence(current: unknown, review: EditorialReview): Record<string, unknown> {
  return { ...record(current), editorial: review };
}

export async function reclassifyUnstableActionTargets(
  siteId: string,
  options: { runId?: string } = {},
) {
  const landingPages = await getDurableLandingPages(siteId);
  const actions = await db.researchAction.findMany({
    where: {
      siteId,
      status: { in: ["PROPOSED", "DRAFT_READY"] },
      targetUrl: { not: null },
      ...(options.runId ? { runId: options.runId } : {}),
    },
    select: {
      id: true,
      kind: true,
      format: true,
      title: true,
      primaryQuery: true,
      targetUrl: true,
      recommendation: true,
      priority: true,
      evidence: true,
      status: true,
    },
  });

  let updated = 0;
  let dismissed = 0;
  for (const action of actions) {
    if (!action.targetUrl) continue;
    const target = classifyEditorialTarget(action.targetUrl);
    if (target.durable) continue;

    const review = deterministicEditorialReview(asContentAction(action), { landingPages });
    if (review.decision === "dismiss") {
      await db.researchAction.update({
        where: { id: action.id },
        data: {
          status: "DISMISSED",
          evidence: editorialEvidence(action.evidence, review) as never,
        },
      });
      dismissed += 1;
      continue;
    }

    const targetUrl = review.decision === "new_article" ? null : review.targetUrl;
    if (!targetUrl || targetUrl === action.targetUrl) continue;
    await db.researchAction.update({
      where: { id: action.id },
      data: {
        title: review.title,
        kind: review.decision === "new_article" ? "create_article" : "add_section",
        format: review.decision === "new_article" ? "article" : "page_update",
        targetUrl,
        recommendation: review.scope,
        evidence: editorialEvidence(action.evidence, review) as never,
      },
    });
    updated += 1;
  }

  return { scanned: actions.length, updated, dismissed, landingPages: landingPages.length };
}
