import { db } from "@/lib/db";
import { buildAgentPrompt } from "@/lib/agent-tasks/prompt";
import { isTechnicalSeoAction, isWixBlogTarget, resolveAgentTarget } from "@/lib/agent-tasks/targets";
import { ResearchServiceError } from "@/lib/research/service";
import { canTransitionAgentTask } from "@/lib/agent-tasks/transitions";
import { autoAgentDecision } from "@/lib/research/automation";
import { preflightTechnicalTarget, type TargetPreflight } from "@/lib/delivery/preflight";
import { createWixPageTaskForAction } from "@/lib/agent-tasks/wix-page";
import { createWixArticleTaskForAction } from "@/lib/agent-tasks/wix-article";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function createAgentTaskForAction(
  actionId: string,
  operatorInstructions?: string,
  options: {
    preflight?: TargetPreflight;
    /**
     * Which delivery lane the work belongs to. Content work defaults to the
     * page lane; an article proposal goes to Wix Blog. Technical fixes keep
     * the repository lane because they change site code, not page content.
     */
    lane?: "page" | "article" | "component";
    route?: string | null;
  } = {},
) {
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    include: {
      site: { select: { id: true, domain: true, connectorBinding: { select: { executor: true, status: true, generation: true } } } },
      drafts: { orderBy: { createdAt: "desc" }, take: 1 },
      agentTasks: { where: { status: { in: ["READY", "RUNNING"] } }, take: 1 },
    },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);
  if (action.site.connectorBinding?.status === "ACTIVE" && action.site.connectorBinding.executor !== "crawlseo-agent") {
    throw new ResearchServiceError("This site is owned by another execution connector", 409);
  }
  if (action.status !== "APPROVED" && action.status !== "DRAFT_READY" && !["ELIGIBLE", "QUEUED"].includes(action.preparationStatus)) {
    throw new ResearchServiceError("The action is not eligible for preparation", 409);
  }

  // A new page has no target yet, so it takes the page lane. An action that
  // already names a page is an update to that page and keeps the component
  // lane, which edits the page's own source instead of replacing it.
  const lane = options.lane ?? (
    action.format === "article" || action.kind === "article" || isWixBlogTarget(action.targetUrl)
      ? "article"
      : isTechnicalSeoAction(action) || action.targetUrl
        ? "component"
        : "page"
  );
  if (lane === "page") {
    return createWixPageTaskForAction({
      actionId,
      operatorInstructions,
      route: options.route ?? null,
    });
  }
  if (lane === "article") {
    return createWixArticleTaskForAction({ actionId, operatorInstructions });
  }

  const evidence = record(action.evidence);
  const preflight = options.preflight ?? await preflightTechnicalTarget({
    siteId: action.siteId,
    targetUrl: action.targetUrl,
    issueType: typeof evidence.issue_type === "string" ? evidence.issue_type : null,
  });
  if (preflight.supported && !preflight.deliverable) {
    throw new ResearchServiceError(
      preflight.reason ?? "The target page has no editable content embed; a code-only fix cannot render there.",
      409,
    );
  }
  if (action.format === "article" || (!isTechnicalSeoAction(action) && isWixBlogTarget(action.targetUrl))) {
    throw new ResearchServiceError(
      "This target is a Wix Blog post. Use the Wix Blog delivery path, not the embed agent task path.",
      409,
    );
  }
  if (!action.targetUrl) {
    throw new ResearchServiceError("Agent tasks require a mapped page route", 409);
  }
  if (action.agentTasks.length > 0) {
    throw new ResearchServiceError("An open agent task already exists for this action", 409);
  }

  const target = resolveAgentTarget(action.site.domain);
  if (!target) {
    throw new ResearchServiceError("No agent target is configured for this site", 409);
  }

  const draft = action.drafts[0] ?? null;
  const prompt = buildAgentPrompt({
    target,
    siteDomain: action.site.domain,
    action: {
      title: action.title,
      recommendation: action.recommendation,
      kind: action.kind,
      format: action.format,
      targetUrl: action.targetUrl,
      primaryQuery: action.primaryQuery,
      priority: action.priority,
      evidence: action.evidence,
    },
    draft: draft
      ? {
          title: draft.title,
          markdown: draft.markdown,
          metaTitle: draft.metaTitle,
          metaDescription: draft.metaDescription,
        }
      : null,
    operatorInstructions,
  });

  return db.agentTask.create({
    data: {
      siteId: action.siteId,
      actionId: action.id,
      actionRevision: action.revision,
      connectorGeneration: action.site.connectorBinding?.generation ?? null,
      draftId: draft?.id,
      kind: "embed_update",
      title: action.title,
      goal: action.recommendation,
      prompt,
      repoPath: target.repoPath,
      route: action.targetUrl,
      branch: `agent/${action.id}`,
    },
  });
}

export async function createAgentTaskIfEligible(
  actionId: string,
  operatorInstructions?: string,
): Promise<
  | { created: true; task: Awaited<ReturnType<typeof createAgentTaskForAction>> }
  | { created: false; reason: string }
> {
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    select: {
      siteId: true,
      targetUrl: true,
      format: true,
      status: true,
      source: true,
      kind: true,
      evidence: true,
      site: { select: { domain: true, siteDeliveryConfig: { select: { enabled: true } } } },
      agentTasks: {
        where: { status: { notIn: ["CLOSED", "COMPLETED", "FAILED", "CANCELLED"] } },
        select: { id: true },
      },
    },
  });
  if (!action) return { created: false, reason: "action_not_found" };
  const evidence = record(action.evidence);
  const preflight = await preflightTechnicalTarget({
    siteId: action.siteId,
    targetUrl: action.targetUrl,
    issueType: typeof evidence.issue_type === "string" ? evidence.issue_type : null,
  });
  if (preflight.supported && !preflight.deliverable) {
    await db.researchAction.update({
      where: { id: actionId },
      data: {
        status: "DISMISSED",
        evidence: { ...evidence, preflight } as never,
      },
    });
    return { created: false, reason: `target_not_deliverable: ${preflight.reason ?? "no content embed"}` };
  }
  if (preflight.supported) {
    await db.researchAction.update({
      where: { id: actionId },
      data: { evidence: { ...evidence, preflight } as never },
    });
  }

  const decision = autoAgentDecision({
    targetUrl: action.targetUrl,
    format: action.format,
    status: action.status,
    source: action.source,
    kind: action.kind,
    hasOpenTask: action.agentTasks.length > 0,
    hasDelivery: Boolean(action.site.siteDeliveryConfig?.enabled),
  });
  if (!decision.eligible) return { created: false, reason: decision.reason };

  return {
    created: true,
    task: await createAgentTaskForAction(actionId, operatorInstructions, { preflight }),
  };
}

export async function listAgentTasks(siteId: string, limit = 50) {
  return db.agentTask.findMany({
    where: { siteId },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 200)),
    include: {
      action: { select: { id: true, title: true, status: true } },
      draft: { select: { id: true, title: true } },
    },
  });
}

export async function updateAgentTask(
  taskId: string,
  input: {
    status?: "READY" | "RUNNING" | "AWAITING_REVIEW" | "AWAITING_TARGET" | "CHANGES_REQUESTED" | "APPROVED" | "COMMITTED" | "PUBLISHING" | "PUBLISHED" | "CLOSED" | "COMPLETED" | "FAILED" | "CANCELLED";
    result?: unknown;
    errorCode?: string | null;
    branch?: string | null;
    worktreePath?: string | null;
    commitSha?: string | null;
    publishedUrl?: string | null;
    bridgeReceiptId?: string | null;
    route?: string | null;
  },
) {
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { id: true, status: true } });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  if (input.status && !canTransitionAgentTask(task.status, input.status)) {
    throw new ResearchServiceError(`Cannot move agent task from ${task.status} to ${input.status}`, 409);
  }
  const now = new Date();
  return db.agentTask.update({
    where: { id: taskId },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.result !== undefined ? { result: input.result as never } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
      ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
      ...(input.publishedUrl !== undefined ? { publishedUrl: input.publishedUrl } : {}),
      ...(input.bridgeReceiptId !== undefined ? { bridgeReceiptId: input.bridgeReceiptId } : {}),
      ...(input.route !== undefined ? { route: input.route } : {}),
      ...(input.status === "RUNNING" ? { startedAt: now } : {}),
      ...(input.status === "CLOSED" ? { closedAt: now } : {}),
      ...(input.status && ["COMPLETED", "FAILED", "CANCELLED"].includes(input.status)
        ? { completedAt: now }
        : {}),
    },
  });
}
