import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResearchActionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";
import { updateResearchAction } from "@/lib/research/service";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { commitAgentTask } from "@/lib/agent-tasks/commit";
import {
  applyEmbedDelivery,
  planEmbedDelivery,
  verifyEmbedDelivery,
} from "@/lib/delivery/wix-embed";
import { selectEmbedTargetKey } from "@/lib/delivery/target-selection";

const execFileAsync = promisify(execFile);

async function resolveEmbedTarget(
  siteId: string,
  action: { title: string; recommendation: string; targetUrl: string | null } | null,
  requestedKey?: string,
): Promise<string> {
  if (requestedKey) return requestedKey;

  const targets = await db.deliveryTarget.findMany({
    where: {
      siteId,
      enabled: true,
      adapter: "wix_embed",
      snippetId: { not: null },
      sourcePath: { not: null },
      componentTag: { not: null },
    },
    orderBy: { key: "asc" },
    select: { key: true, componentTag: true },
  });
  if (targets.length === 0) {
    throw new ResearchServiceError("No enabled embed target is mapped for this site", 409);
  }

  const key = selectEmbedTargetKey(targets, {
    title: action?.title,
    targetUrl: action?.targetUrl,
  });
  if (key) return key;
  throw new ResearchServiceError(
    "Could not determine a unique embed target. Select the target manually.",
    409,
  );
}

export async function markActionVerified(actionId: string | null) {
  if (!actionId) return;
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    select: { id: true, status: true },
  });
  if (!action || ["VERIFIED", "FULFILLED", "DISMISSED", "FAILED"].includes(action.status)) return;

  const pathByStatus: Record<string, ResearchActionStatus[]> = {
    PROPOSED: ["APPROVED", "DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    APPROVED: ["DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    DRAFTING: ["DRAFT_READY", "DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    DRAFT_READY: ["DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    DELIVERY_APPROVED: ["DELIVERING", "DELIVERED", "VERIFIED"],
    DELIVERING: ["DELIVERED", "VERIFIED"],
    DELIVERED: ["VERIFIED"],
  };
  for (const status of pathByStatus[action.status] ?? []) {
    await updateResearchAction(action.id, { status }, "agent-deploy");
  }
}

export async function approveAndDeployAgentTask(taskId: string, requestedTargetKey?: string) {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      siteId: true,
      status: true,
      actionId: true,
      commitSha: true,
      action: { select: { title: true, recommendation: true, targetUrl: true } },
    },
  });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  if (!["AWAITING_REVIEW", "APPROVED", "COMMITTED"].includes(task.status)) {
    throw new ResearchServiceError(
      "Only reviewable or committed tasks can be deployed",
      409,
    );
  }

  const targetKey = await resolveEmbedTarget(task.siteId, task.action, requestedTargetKey);
  const target = await db.deliveryTarget.findUnique({
    where: { siteId_key: { siteId: task.siteId, key: targetKey } },
    select: { key: true, enabled: true, snippetId: true, sourcePath: true, componentTag: true, route: true },
  });
  if (!target || !target.enabled || !target.snippetId || !target.sourcePath || !target.componentTag) {
    throw new ResearchServiceError("The selected embed target is not deployable", 409);
  }

  let commitSha = task.commitSha;
  if (task.status === "AWAITING_REVIEW") {
    const taskDetail = await db.agentTask.findUnique({
    where: { id: task.id },
    select: { worktreePath: true },
  });
  if (!taskDetail?.worktreePath) {
    throw new ResearchServiceError("Agent worktree is missing", 409);
  }
  const status = await execFileAsync("git", ["-C", taskDetail.worktreePath, "status", "--porcelain"], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const changedFiles = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[A-Z?]{1,2}\s+/, "").replace(/^"|"$/g, ""))
    .filter(Boolean);
  const outsideTarget = changedFiles.filter((file) => file !== target.sourcePath);
  if (outsideTarget.length > 0) {
    throw new ResearchServiceError(
      `This task also changes site code that the embed bridge cannot deploy: ${outsideTarget.join(", ")}. Publish the site source separately or restrict the task to ${target.sourcePath}.`,
      409,
    );
  }

  await updateAgentTask(task.id, { status: "APPROVED", errorCode: null });
    commitSha = (await commitAgentTask(task.id)).commitSha;
  } else if (task.status === "APPROVED") {
    commitSha = (await commitAgentTask(task.id)).commitSha;
  } else if (!commitSha) {
    throw new ResearchServiceError("Committed task has no commit SHA", 409);
  }
  const plan = await planEmbedDelivery(task.id, targetKey);
  const receipt = await applyEmbedDelivery(task.id, targetKey, plan.confirmation);
  const verification = await verifyEmbedDelivery(task.id, targetKey);

  if (!verification.verified) {
    await updateAgentTask(task.id, { errorCode: "EMBED_VERIFY_FAILED" });
    throw new ResearchServiceError(
      `The embed was applied but did not verify (${verification.actualSha256} != ${verification.expectedSha256})`,
      502,
    );
  }

  await markActionVerified(task.actionId);
  const closed = await updateAgentTask(task.id, {
    status: "CLOSED",
    publishedUrl: target.route ?? null,
    bridgeReceiptId:
      (receipt as { operationId?: string; releaseId?: string }).operationId ??
      (receipt as { releaseId?: string }).releaseId ??
      null,
  });

  return {
    task: closed,
    commitSha,
    target: target.key,
    snippetId: target.snippetId,
    plan: plan.plan,
    receipt,
    verification,
  };
}
