import { db } from "@/lib/db";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { ResearchServiceError } from "@/lib/research/service";
import { generateDraftForAction, generateWixBlogUpdateDraftForAction } from "@/lib/research/content";
import { isWixBlogTarget } from "@/lib/agent-tasks/targets";
import { approveAndPublishWixBlogDraft } from "@/lib/delivery/wix-blog";
import { markOpportunityTaskDelivered } from "@/lib/agent-tasks/opportunity-task";
import { editorialEnabled } from "@/lib/editorial-service/client";
import { startEditorialArticleTask } from "@/lib/editorial-service/article-task";

/**
 * The article lane. There is no page and no embed: the reviewed draft is the
 * deliverable, and approval publishes it through Wix Blog in one step.
 */
export async function createWixArticleTaskForAction(input: {
  actionId: string;
  operatorInstructions?: string;
}) {
  const action = await db.researchAction.findUnique({
    where: { id: input.actionId },
    include: {
      site: { select: { id: true, domain: true, connectorBinding: { select: { executor: true, status: true } } } },
      drafts: { orderBy: { createdAt: "desc" }, take: 1 },
      agentTasks: {
        where: { status: { notIn: ["CLOSED", "COMPLETED", "FAILED", "CANCELLED"] } },
        select: { id: true },
      },
    },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);
  if (action.site.connectorBinding?.status === "ACTIVE" && action.site.connectorBinding.executor !== "crawlseo-agent") {
    throw new ResearchServiceError("This site is owned by another execution connector", 409);
  }
  if (action.agentTasks.length > 0) {
    throw new ResearchServiceError("An open agent task already exists for this action", 409);
  }

  const existingPost = Boolean(action.targetUrl && isWixBlogTarget(action.targetUrl));

  // A new article is written by the editorial service: quote-first, verified,
  // async. An existing post keeps the synchronous update path, which needs the
  // post's current body. Without an editorial service the old generator runs,
  // so this switch is safe to deploy before the service is configured.
  if (!existingPost && editorialEnabled()) {
    return startEditorialArticleTask({
      actionId: action.id,
      operatorInstructions: input.operatorInstructions,
    });
  }

  let draft = action.drafts[0] ?? null;
  if (!draft || draft.format !== "article") {
    // An existing post is updated from its current body; a new article is
    // written from the action evidence. Both produce an article draft.
    draft = existingPost
      ? await generateWixBlogUpdateDraftForAction(action.id, input.operatorInstructions)
      : await generateDraftForAction(action.id, input.operatorInstructions, {
          requireApproval: false,
          forceArticle: true,
        });
  }
  if (!draft) throw new ResearchServiceError("The article draft could not be prepared", 502);

  const task = await db.agentTask.create({
    data: {
      siteId: action.siteId,
      actionId: action.id,
      actionRevision: action.revision,
      draftId: draft.id,
      kind: "wix_article",
      title: draft.title,
      goal: action.recommendation,
      prompt: [
        `Article: ${draft.title}`,
        `Slug: ${draft.slug}`,
        `Meta title: ${draft.metaTitle}`,
        `Meta description: ${draft.metaDescription}`,
        "",
        "The draft is the deliverable. Review it, then approve to publish through Wix Blog.",
      ].join("\n"),
      repoPath: "",
      route: draft.targetUrl ?? null,
      branch: null,
      status: "AWAITING_REVIEW",
    },
  });
  return task;
}

export async function approveAndPublishWixArticle(taskId: string, userId: string) {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, kind: true, status: true, draftId: true },
  });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  if (task.kind !== "wix_article") throw new ResearchServiceError("This task is not an article task", 409);
  if (task.status !== "AWAITING_REVIEW") {
    throw new ResearchServiceError(`Approve a task in AWAITING_REVIEW, not ${task.status}`, 409);
  }
  if (!task.draftId) throw new ResearchServiceError("The task has no draft", 409);

  await updateAgentTask(task.id, { status: "APPROVED" });
  await updateAgentTask(task.id, { status: "PUBLISHING" });
  try {
    const delivery = await approveAndPublishWixBlogDraft(task.draftId, userId);
    const payload = (delivery.payload ?? {}) as Record<string, unknown>;
    const liveUrl = typeof payload.live_url === "string" ? payload.live_url : null;
    await markOpportunityTaskDelivered(task.id, userId).catch(() => undefined);
    return updateAgentTask(task.id, {
      status: "PUBLISHED",
      publishedUrl: liveUrl,
      result: {
        delivery: {
          platform: "wix_blog",
          externalId: delivery.externalId,
          status: delivery.status,
          liveUrl,
        },
      } as never,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publishing failed";
    await updateAgentTask(task.id, {
      status: "FAILED",
      errorCode: message.slice(0, 120),
      result: { deliveryError: message.slice(0, 1_000) } as never,
    });
    throw error;
  }
}
