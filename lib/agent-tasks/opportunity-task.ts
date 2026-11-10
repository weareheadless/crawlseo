import { db } from "@/lib/db";
import { createAgentTaskForAction } from "@/lib/agent-tasks/service";
import { isWixBlogTarget } from "@/lib/agent-tasks/targets";
import { ResearchServiceError } from "@/lib/research/service";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type PreparedOpportunityTask = {
  id: string;
  kind: string;
  status: string;
  route: string | null;
};

/**
 * Connect an accepted funnel opportunity to the delivery loop.
 *
 * The funnel task is the human's record; the research action and agent task
 * are what actually prepare and deliver the page or article. One opportunity
 * maps to one action, keyed by `opportunity:<id>`, so pressing prepare twice
 * returns the same task.
 *
 * The lane is read from the recommendation's target, not from its `kind`:
 * a blog URL is an article, a new asset (or no target) is a page, and an
 * existing page is a component update. `kind: "article"` only says the work is
 * content; it does not say it is a blog post.
 */
export async function prepareOpportunityWithAgent(
  opportunityId: string,
  siteId: string,
): Promise<PreparedOpportunityTask> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, projectId: true },
  });
  if (!site) throw new ResearchServiceError("Site not found", 404);
  const opportunity = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: { tasks: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!opportunity) throw new ResearchServiceError("Opportunity not found", 404);
  if (opportunity.projectId !== site.projectId) {
    throw new ResearchServiceError("This opportunity does not belong to the site's project", 409);
  }
  const funnelTask = opportunity.tasks[0];
  if (!funnelTask) {
    throw new ResearchServiceError("Accept the opportunity before preparing it", 409);
  }

  const plan = record(funnelTask.plan);
  if (typeof plan.agentTaskId === "string") {
    const existing = await db.agentTask.findUnique({
      where: { id: plan.agentTaskId },
      select: { id: true, kind: true, status: true, route: true },
    });
    if (existing) return existing;
  }

  const recommendation = record(opportunity.recommendationDecision);
  const target = record(recommendation.target);
  const targetUrl = typeof target.url === "string" && target.url.trim() ? target.url.trim() : null;
  const newAsset = target.newAsset === true;
  const lane: "page" | "article" | "component" = targetUrl && isWixBlogTarget(targetUrl)
    ? "article"
    : newAsset || !targetUrl
      ? "page"
      : "component";

  let route: string | null = null;
  if (lane === "page" && targetUrl) {
    try {
      route = new URL(targetUrl).pathname.replace(/\/+$/, "") || null;
    } catch {
      route = null;
    }
  }

  const dedupeKey = `opportunity:${opportunity.id}`;
  const recommendationText = typeof recommendation.action === "string" && recommendation.action.trim()
    ? recommendation.action
    : opportunity.summary;
  const evidence = {
    opportunityId: opportunity.id,
    opportunityTitle: opportunity.title,
    recommendationDecision: recommendation,
    scoreInputs: opportunity.scoreInputs,
  };

  const action = await db.researchAction.upsert({
    where: { siteId_dedupeKey: { siteId: site.id, dedupeKey } },
    create: {
      siteId: site.id,
      projectId: opportunity.projectId,
      source: "opportunity",
      kind: lane === "article" ? "create_article" : "improve_page",
      format: lane === "article" ? "article" : "page_update",
      title: opportunity.title,
      recommendation: recommendationText,
      targetUrl,
      priority: Math.max(1, Math.min(100, opportunity.scoreValue ?? 50)),
      evidence: evidence as never,
      status: "APPROVED",
      preparationStatus: "QUEUED",
      automationMode: "ASSISTED",
      dedupeKey,
    },
    update: {
      status: "APPROVED",
      preparationStatus: "QUEUED",
      targetUrl,
      recommendation: recommendationText,
      priority: Math.max(1, Math.min(100, opportunity.scoreValue ?? 50)),
      evidence: evidence as never,
    },
  });

  const agentTask = await createAgentTaskForAction(
    action.id,
    "Prepared from the accepted opportunity. Review the deliverable, then confirm delivery once.",
    { lane, route },
  );

  await db.task.update({
    where: { id: funnelTask.id },
    data: {
      status: "in_progress",
      plan: {
        ...plan,
        agentTaskId: agentTask.id,
        agentTaskKind: agentTask.kind,
        agentTaskStatus: agentTask.status,
        preparedAt: new Date().toISOString(),
      } as never,
    },
  });

  return { id: agentTask.id, kind: agentTask.kind, status: agentTask.status, route: agentTask.route };
}

/**
 * Close the funnel task that owns this agent task. The human's approval of the
 * delivered page or article is the confirmation; the manual "I shipped this"
 * is not used when an agent task exists.
 */
export async function markOpportunityTaskDelivered(agentTaskId: string, confirmedBy: string | null) {
  await db.task.updateMany({
    where: { plan: { path: ["agentTaskId"], equals: agentTaskId } },
    data: {
      status: "delivered",
      humanConfirmedBy: confirmedBy,
      humanConfirmedAt: new Date(),
    },
  });
}
