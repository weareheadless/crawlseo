import { db } from "@/lib/db";
import { buildAgentPrompt } from "@/lib/agent-tasks/prompt";
import { isWixBlogTarget, resolveAgentTarget } from "@/lib/agent-tasks/targets";
import { ResearchServiceError } from "@/lib/research/service";

export async function createAgentTaskForAction(
  actionId: string,
  operatorInstructions?: string,
) {
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    include: {
      site: { select: { id: true, domain: true } },
      drafts: { orderBy: { createdAt: "desc" }, take: 1 },
      agentTasks: { where: { status: { in: ["READY", "RUNNING"] } }, take: 1 },
    },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);
  if (action.status !== "APPROVED" && action.status !== "DRAFT_READY") {
    throw new ResearchServiceError("Approve the action before creating an agent task", 409);
  }
  if (action.format === "article" || isWixBlogTarget(action.targetUrl)) {
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
    status?: "READY" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
    result?: unknown;
    errorCode?: string | null;
    branch?: string | null;
    worktreePath?: string | null;
  },
) {
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  const now = new Date();
  return db.agentTask.update({
    where: { id: taskId },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.result !== undefined ? { result: input.result as never } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
      ...(input.status === "RUNNING" ? { startedAt: now } : {}),
      ...(input.status && ["COMPLETED", "FAILED", "CANCELLED"].includes(input.status)
        ? { completedAt: now }
        : {}),
    },
  });
}
