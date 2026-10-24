import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";
import { commitAgentTask } from "@/lib/agent-tasks/commit";
import { markActionVerified } from "@/lib/agent-tasks/deploy";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { selectEmbedTargetKey } from "@/lib/delivery/target-selection";
import { publishWixSite, readWixConfig } from "@/lib/delivery/wix-publish";
import {
  applyEmbedDelivery,
  planEmbedDelivery,
  verifyEmbedDelivery,
} from "@/lib/delivery/wix-embed";

const execFileAsync = promisify(execFile);

export async function mergeAndPush(repoPath: string, commitSha: string) {
  const status = await execFileAsync("git", ["-C", repoPath, "status", "--porcelain"], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (status.stdout.trim()) {
    throw new ResearchServiceError(`Site repository is not clean: ${status.stdout.trim().split(/\r?\n/)[0]}`, 409);
  }
  const branch = (await execFileAsync("git", ["-C", repoPath, "branch", "--show-current"], { timeout: 30_000 })).stdout.trim();
  if (branch !== "main") {
    throw new ResearchServiceError(`Site repository must be on main, found ${branch || "detached"}`, 409);
  }
  await execFileAsync("git", ["-C", repoPath, "fetch", "origin"], { timeout: 60_000 });
  const remote = (await execFileAsync("git", ["-C", repoPath, "rev-parse", "origin/main"], { timeout: 30_000 })).stdout.trim();
  const head = (await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim();
  if (head !== remote) {
    throw new ResearchServiceError("Local main is not at origin/main; fetch or reconcile before releasing", 409);
  }
  await execFileAsync("git", ["-C", repoPath, "merge", "--no-ff", "--no-edit", commitSha], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const releaseSha = (await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim();
  await execFileAsync("git", ["-C", repoPath, "push", "origin", "main"], { timeout: 120_000 });
  return releaseSha;
}

async function changedFiles(worktreePath: string): Promise<string[]> {
  const status = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain"], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[A-Z?]{1,2}\s+/, "").replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function isAllowedSiteCode(file: string, targetSourcePath: string): boolean {
  return file === targetSourcePath
    || /^src\/pages\/[^/]+\.js$/i.test(file)
    || /^src\/public\/[^/]+\.js$/i.test(file)
    || /^src\/public\/custom-elements\/[^/]+\.js$/i.test(file)
    || /^scripts\/test-[^/]+\.mjs$/i.test(file);
}

export async function approveAndReleaseAgentTask(taskId: string, requestedTargetKey?: string) {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      siteId: true,
      status: true,
      title: true,
      actionId: true,
      repoPath: true,
      branch: true,
      worktreePath: true,
      commitSha: true,
      route: true,
      action: {
        select: {
          title: true,
          recommendation: true,
          targetUrl: true,
          site: { select: { domain: true } },
        },
      },
    },
  });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  if (!["AWAITING_REVIEW", "CHANGES_REQUESTED"].includes(task.status)) {
    throw new ResearchServiceError("Only tasks awaiting review or retry can be released", 409);
  }
  if (!task.worktreePath || !task.route) {
    throw new ResearchServiceError("The task is missing its worktree or target route", 409);
  }

  const delivery = await getSiteDeliveryConfig(task.siteId);
  if (!delivery?.enabled || !Array.isArray(delivery.adapters) || !delivery.adapters.includes("wix_embed")) {
    throw new ResearchServiceError("Wix embed delivery is not enabled for this site", 409);
  }
  const targets = await db.deliveryTarget.findMany({
    where: {
      siteId: task.siteId,
      enabled: true,
      adapter: "wix_embed",
      snippetId: { not: null },
      sourcePath: { not: null },
      componentTag: { not: null },
    },
    select: { key: true, sourcePath: true, snippetId: true, componentTag: true, route: true },
  });
  const targetKey = requestedTargetKey ?? selectEmbedTargetKey(targets, {
    title: task.action?.title ?? task.title,
    targetUrl: task.action?.targetUrl ?? task.route,
  });
  const target = targetKey ? targets.find((item) => item.key === targetKey) : null;
  if (!target || !target.sourcePath || !target.snippetId) {
    throw new ResearchServiceError("Could not determine a unique embed target for this release", 409);
  }

  const worktreeFiles = await changedFiles(task.worktreePath);
  const existingCommit = worktreeFiles.length === 0 ? task.commitSha : null;
  if (worktreeFiles.length === 0 && !existingCommit) {
    throw new ResearchServiceError("The task has no worktree changes or committed SHA to release", 409);
  }
  if (existingCommit) {
    const worktreeHead = (await execFileAsync("git", ["-C", task.worktreePath, "rev-parse", "HEAD"], {
      timeout: 30_000,
    })).stdout.trim();
    if (worktreeHead !== existingCommit) {
      throw new ResearchServiceError(
        `The task worktree is at ${worktreeHead}, not its recorded commit ${existingCommit}`,
        409,
      );
    }
  }
  const files = worktreeFiles.length > 0
    ? worktreeFiles
    : (await execFileAsync("git", ["-C", task.worktreePath, "show", "--pretty=format:", "--name-only", existingCommit!], {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      })).stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
  const disallowed = files.filter((file) => !isAllowedSiteCode(file, target.sourcePath!));
  if (disallowed.length > 0) {
    throw new ResearchServiceError(
      `This task changes files outside the allowed site-code and embed scope: ${disallowed.join(", ")}`,
      409,
    );
  }

  await updateAgentTask(task.id, { status: "APPROVED", errorCode: null });
  const committed = existingCommit
    ? { commitSha: existingCommit }
    : await commitAgentTask(task.id);
  const releaseHead = await mergeAndPush(task.repoPath, committed.commitSha);
  if (existingCommit) {
    await updateAgentTask(task.id, { status: "COMMITTED", commitSha: existingCommit, errorCode: null });
  }

  let publication;
  try {
    const wixConfig = await readWixConfig(task.repoPath);
    publication = await publishWixSite({
      repoPath: task.repoPath,
      siteId: wixConfig.siteId,
      gitSha: releaseHead,
    });
  } catch (error) {
    await updateAgentTask(task.id, {
      status: "CHANGES_REQUESTED",
      errorCode: "SITE_RELEASE_FAILED",
      result: {
        commitSha: committed.commitSha,
        mergedSha: releaseHead,
        release: {
          status: "failed",
          error: error instanceof Error ? error.message : "release failed",
        },
      },
    });
    throw new ResearchServiceError(
      `Site code was committed and pushed, but the Wix release failed: ${error instanceof Error ? error.message : "unknown error"}`,
      502,
    );
  }

  let embedPlan;
  let embedReceipt;
  let verification;
  try {
    const planned = await planEmbedDelivery(task.id, target.key);
    embedPlan = planned.plan;
    const applied = await applyEmbedDelivery(task.id, target.key, `apply-embed:${task.id}:${target.key}`);
    embedReceipt = applied.receipt;
    verification = await verifyEmbedDelivery(task.id, target.key);
  } catch (error) {
    await updateAgentTask(task.id, {
      status: "CHANGES_REQUESTED",
      errorCode: "EMBED_DELIVERY_FAILED",
      result: {
        commitSha: committed.commitSha,
        mergedSha: releaseHead,
        publication,
        embedError: error instanceof Error ? error.message : "embed delivery failed",
      },
    });
    throw new ResearchServiceError(
      `Wix code was published, but the embed update failed: ${error instanceof Error ? error.message : "unknown error"}`,
      502,
    );
  }

  if (!verification.verified) {
    await updateAgentTask(task.id, {
      status: "CHANGES_REQUESTED",
      errorCode: "EMBED_VERIFY_FAILED",
      result: {
        commitSha: committed.commitSha,
        mergedSha: releaseHead,
        publication,
        verification,
      },
    });
    throw new ResearchServiceError(
      `The embed was applied but did not verify (${verification.actualSha256} != ${verification.expectedSha256})`,
      502,
    );
  }

  const releaseId = (embedReceipt as { operationId?: string; releaseId?: string }).operationId
    ?? (embedReceipt as { releaseId?: string }).releaseId
    ?? null;
  await markActionVerified(task.actionId);
  const closed = await updateAgentTask(task.id, {
    status: "CLOSED",
    publishedUrl: target.route ?? task.route,
    bridgeReceiptId: releaseId,
    result: {
      commitSha: committed.commitSha,
      releaseSha: publication.releaseSha,
      mergedSha: releaseHead,
      publication,
      embed: {
        target: target.key,
        snippetId: target.snippetId,
        plan: embedPlan,
        receipt: embedReceipt,
        verification,
      },
    },
  });
  return {
    task: closed,
    commitSha: committed.commitSha,
    releaseSha: publication.releaseSha,
    target: target.key,
    publication,
    plan: embedPlan,
    receipt: embedReceipt,
    verification,
  };
}
