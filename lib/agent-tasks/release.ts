import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";
import { commitAgentTask } from "@/lib/agent-tasks/commit";
import { markActionVerified } from "@/lib/agent-tasks/deploy";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { addAgentArtifact } from "@/lib/agent-tasks/chat";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { selectEmbedTargetKey } from "@/lib/delivery/target-selection";
import { isTechnicalSeoAction } from "@/lib/agent-tasks/targets";
import { publishWixSite, readWixConfig, WixPublicationOutcomeUnknown, type PublicationResult } from "@/lib/delivery/wix-publish";
import { verifyReleaseOutcome } from "@/lib/research/release-verification";
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
      actionRevision: true,
      connectorGeneration: true,
      repoPath: true,
      branch: true,
      worktreePath: true,
      commitSha: true,
      route: true,
      action: {
        select: {
          revision: true,
          title: true,
          recommendation: true,
          targetUrl: true,
          source: true,
          kind: true,
          evidence: true,
          site: { select: { domain: true } },
        },
      },
    },
  });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  if (!["AWAITING_REVIEW", "CHANGES_REQUESTED"].includes(task.status)) {
    throw new ResearchServiceError("Only tasks awaiting review or retry can be released", 409);
  }
  if (task.connectorGeneration !== null) {
    throw new ResearchServiceError("Wix code publication is unsupported for connector-bound Actions until the generic bridge capability is qualified", 409);
  }
  if (task.actionId && (task.actionRevision === null || task.action?.revision !== task.actionRevision)) {
    throw new ResearchServiceError("Action revision changed since this task was prepared", 409);
  }
  if (!task.worktreePath || !task.route) {
    throw new ResearchServiceError("The task is missing its worktree or target route", 409);
  }

  const technical = isTechnicalSeoAction({
    source: task.action?.source,
    kind: task.action?.kind,
  });
  let target: {
    key: string;
    sourcePath: string;
    snippetId: string;
    componentTag: string | null;
    route: string | null;
  } | null = null;

  if (!technical) {
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
    const selected = targetKey ? targets.find((item) => item.key === targetKey) : null;
    if (!selected || !selected.sourcePath || !selected.snippetId) {
      throw new ResearchServiceError("Could not determine a unique embed target for this release", 409);
    }
    target = {
      key: selected.key,
      sourcePath: selected.sourcePath,
      snippetId: selected.snippetId,
      componentTag: selected.componentTag,
      route: selected.route,
    };
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
  const disallowed = files.filter((file) => !isAllowedSiteCode(file, target?.sourcePath ?? ""));
  if (disallowed.length > 0) {
    throw new ResearchServiceError(
      `This task changes files outside the allowed site-code and embed scope: ${disallowed.join(", ")}`,
      409,
    );
  }

  const claimed = await db.agentTask.updateMany({
    where: {
      id: task.id,
      status: task.status,
      actionRevision: task.actionRevision,
      commitSha: task.commitSha,
      ...(task.actionId ? { action: { is: { revision: task.actionRevision! } } } : {}),
    },
    data: { status: "APPROVED", errorCode: null },
  });
  if (claimed.count !== 1) throw new ResearchServiceError("Another executor changed this task or Action revision; refresh and retry", 409);
  // The status fence above is the single-winner claim. Keep it through the
  // external publish, including unknown outcomes; never reopen for a blind retry.
  const committed = existingCommit
    ? { commitSha: existingCommit }
    : await commitAgentTask(task.id);
  if (task.actionId) {
    const currentAction = await db.researchAction.findUnique({ where: { id: task.actionId }, select: { revision: true } });
    if (!currentAction || currentAction.revision !== task.actionRevision) {
      throw new ResearchServiceError("Action revision changed before the site release", 409);
    }
  }
  const releaseHead = await mergeAndPush(task.repoPath, committed.commitSha);
  if (existingCommit) {
    await updateAgentTask(task.id, { status: "COMMITTED", commitSha: existingCommit, errorCode: null });
  }

  let publication;
  let publishAttemptId: string | null = null;
  let publishStartedDurably = false;
  try {
    const wixConfig = await readWixConfig(task.repoPath);
    const priorPublishes = await db.agentTaskArtifact.findMany({
      where: { taskId: task.id, kind: { in: ["wix_publish_started", "wix_publish_receipt", "wix_publish_unknown", "wix_publish_not_started"] } },
      orderBy: { createdAt: "desc" }, select: { kind: true, content: true, createdAt: true },
    });
    const attemptId = (artifact: (typeof priorPublishes)[number]) => {
      try { return JSON.parse(artifact.content ?? "").attemptId as string | undefined; } catch { return undefined; }
    };
    const started = priorPublishes.filter((item) => item.kind === "wix_publish_started");
    for (const item of started) {
      const id = attemptId(item);
      const terminal = priorPublishes.filter((entry) => entry.kind !== "wix_publish_started" && attemptId(entry) === id);
      if (!id || terminal.some((entry) => entry.kind === "wix_publish_unknown")
          || !terminal.some((entry) => entry.kind === "wix_publish_receipt" || entry.kind === "wix_publish_not_started")) {
        throw new ResearchServiceError("A Wix code publication has an uncertain outcome; reconcile it before retrying", 409);
      }
    }
    const previous = priorPublishes.find((item) => item.kind === "wix_publish_receipt");
    if (previous?.kind === "wix_publish_receipt") {
      if (!previous.content) throw new ResearchServiceError("The prior Wix publication receipt is missing; reconcile it before retrying", 409);
      let saved: PublicationResult;
      try { saved = JSON.parse(previous.content) as PublicationResult; }
      catch { throw new ResearchServiceError("The prior Wix publication receipt is unreadable; reconcile it before retrying", 409); }
      if (!saved.codeSha || !saved.releaseSha || !saved.revisionPublished?.revision) {
        throw new ResearchServiceError("The prior Wix publication receipt is incomplete; reconcile it before retrying", 409);
      }
      if (saved.codeSha !== releaseHead) throw new ResearchServiceError("A prior Wix publication receipt belongs to a different commit", 409);
      publication = saved;
    }
    if (!publication) {
      if (task.actionId) {
        const currentAction = await db.researchAction.findUnique({ where: { id: task.actionId }, select: { revision: true } });
        if (!currentAction || currentAction.revision !== task.actionRevision) {
          throw new ResearchServiceError("Action revision changed before Wix publication", 409);
        }
      }
      publishAttemptId = randomUUID();
      const publishAttempt = {
        attemptId: publishAttemptId,
        siteId: wixConfig.siteId,
        commitSha: releaseHead,
        startedAt: new Date().toISOString(),
      };
      await addAgentArtifact(task.id, { kind: "wix_publish_started", content: JSON.stringify(publishAttempt) });
      publishStartedDurably = true;
      publication = await publishWixSite({
        repoPath: task.repoPath,
        siteId: wixConfig.siteId,
        gitSha: releaseHead,
      });
      try {
        await addAgentArtifact(task.id, { kind: "wix_publish_receipt", content: JSON.stringify({ attemptId: publishAttemptId, ...publication }) });
      } catch {
        throw new WixPublicationOutcomeUnknown("Wix publish succeeded but its local receipt could not be persisted");
      }
    }
  } catch (error) {
    if (!(error instanceof ResearchServiceError)) {
      await addAgentArtifact(task.id, {
        // Once the durable start marker exists, every later error is
        // conservatively uncertain. In particular, receipt persistence can
        // fail after Wix has already published; never authorize a blind retry.
        kind: publishStartedDurably || error instanceof WixPublicationOutcomeUnknown
          ? "wix_publish_unknown" : "wix_publish_not_started",
        content: JSON.stringify({
          attemptId: publishAttemptId,
          commitSha: releaseHead,
          outcome: publishStartedDurably || error instanceof WixPublicationOutcomeUnknown ? "unknown" : "not_started",
          error: error instanceof Error ? error.message : "Wix release failed",
          recordedAt: new Date().toISOString(),
        }),
      });
    }
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

  let embedPlan = null;
  let embedReceipt = null;
  let verification = null;
  try {
    if (target) {
      const planned = await planEmbedDelivery(task.id, target.key);
      embedPlan = planned.plan;
      const applied = await applyEmbedDelivery(task.id, target.key, planned.confirmation);
      embedReceipt = applied.receipt;
      verification = await verifyEmbedDelivery(task.id, target.key);
    }
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

  if (verification && !verification.verified) {
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

  const outcomeVerification = await verifyReleaseOutcome({
    targetUrl: target?.route ?? task.route,
    evidence: task.action?.evidence,
  });
  if (outcomeVerification.supported && outcomeVerification.verified !== true) {
    const errorCode = outcomeVerification.verified === false
      ? "RELEASE_OUTCOME_NOT_VERIFIED"
      : "RELEASE_VERIFICATION_UNAVAILABLE";
    await updateAgentTask(task.id, {
      status: "CHANGES_REQUESTED",
      errorCode,
      result: {
        commitSha: committed.commitSha,
        mergedSha: releaseHead,
        publication,
        outcomeVerification,
      },
    });
    throw new ResearchServiceError(
      `Wix code was published, but the issue was not verified after release: ${outcomeVerification.reason ?? "unknown verification failure"}`,
      502,
    );
  }

  const releaseId = embedReceipt
    ? (embedReceipt as { operationId?: string; releaseId?: string }).operationId
      ?? (embedReceipt as { releaseId?: string }).releaseId
      ?? null
    : null;
  await markActionVerified(task.actionId);
  const closed = await updateAgentTask(task.id, {
    status: "CLOSED",
    publishedUrl: target?.route ?? task.route,
    bridgeReceiptId: releaseId,
    result: {
      commitSha: committed.commitSha,
      releaseSha: publication.releaseSha,
      mergedSha: releaseHead,
      publication,
      outcomeVerification,
      embed: target ? {
        target: target.key,
        snippetId: target.snippetId,
        plan: embedPlan,
        receipt: embedReceipt,
        verification,
      } : null,
    },
  });
  return {
    task: closed,
    commitSha: committed.commitSha,
    releaseSha: publication.releaseSha,
    target: target?.key ?? null,
    publication,
    plan: embedPlan,
    receipt: embedReceipt,
    verification,
  };
}
