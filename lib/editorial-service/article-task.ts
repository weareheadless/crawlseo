import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { addAgentMessage } from "@/lib/agent-tasks/chat";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobKind } from "@prisma/client";
import {
  createEditorialPost,
  editorialTerminal,
  getEditorialPost,
  type EditorialArtifact,
  type EditorialPost,
} from "@/lib/editorial-service/client";
import { buildEditorialBrief } from "@/lib/editorial-service/brief";

/**
 * The article lane, written by the editorial service.
 *
 * A new article is an async job: the brief goes out, the agent task sits at
 * RUNNING with the editorial post id in its result, and a reconciler turns the
 * verified artifact into the ContentDraft a human reviews. CrawlSEO still owns
 * approval and Wix Blog delivery; editorial never publishes here.
 */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function startEditorialArticleTask(input: {
  actionId: string;
  operatorInstructions?: string;
}) {
  const action = await db.researchAction.findUnique({
    where: { id: input.actionId },
    select: {
      id: true,
      siteId: true,
      revision: true,
      title: true,
      recommendation: true,
      targetUrl: true,
      evidence: true,
      site: { select: { projectId: true } },
      agentTasks: {
        where: { status: { notIn: ["CLOSED", "COMPLETED", "FAILED", "CANCELLED"] } },
        select: { id: true },
      },
    },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);
  if (action.agentTasks.length > 0) {
    throw new ResearchServiceError("An open agent task already exists for this action", 409);
  }

  // One task per action revision. A failed attempt on the same revision is
  // reopened rather than duplicated, so a held or errored article can be retried
  // after the human fixes the brief.
  const previous = await db.agentTask.findUnique({
    where: { actionId_actionRevision: { actionId: action.id, actionRevision: action.revision } },
    select: { id: true, status: true },
  });
  if (previous && !["FAILED", "CANCELLED"].includes(previous.status)) {
    throw new ResearchServiceError(`An agent task for revision ${action.revision} already exists`, 409);
  }

  const { brief, tenant, locale } = await buildEditorialBrief({
    actionId: action.id,
    operatorInstructions: input.operatorInstructions,
    fresh: Boolean(previous),
  });
  const created = await createEditorialPost(brief);
  const result = {
    editorial: { post_id: created.postId, tenant, locale, state: created.state },
    action_revision: action.revision,
    intent: typeof record(action.evidence).intent === "string"
      ? record(action.evidence).intent
      : "informational",
  };

  if (previous) {
    await updateAgentTask(previous.id, { status: "READY" });
    await updateAgentTask(previous.id, {
      status: "RUNNING",
      result: result as never,
      errorCode: null,
      route: action.targetUrl ?? null,
    });
    await enqueueJob({
      siteId: action.siteId,
      projectId: action.site.projectId,
      kind: JobKind.EDITORIAL_ARTICLE,
      payload: { agentTaskId: previous.id, postId: created.postId },
      idempotencyKey: `editorial:${created.postId}`,
      maxAttempts: 10,
    });
    return db.agentTask.findUniqueOrThrow({ where: { id: previous.id } });
  }

  const task = await db.agentTask.create({
    data: {
      siteId: action.siteId,
      actionId: action.id,
      actionRevision: action.revision,
      kind: "wix_article",
      title: action.title,
      goal: action.recommendation,
      prompt: [
        `Article: ${action.title}`,
        "",
        "Editorial is writing and verifying the draft from the site's own pages.",
        "The task moves to review when the verified artifact arrives; the review is the gate.",
        "Approval publishes through Wix Blog. Editorial never publishes.",
      ].join("\n"),
      repoPath: "",
      route: action.targetUrl ?? null,
      branch: null,
      status: "RUNNING",
      startedAt: new Date(),
      result: result as never,
    },
  });

  await enqueueJob({
    siteId: action.siteId,
    projectId: action.site.projectId,
    kind: JobKind.EDITORIAL_ARTICLE,
    payload: { agentTaskId: task.id, postId: created.postId },
    idempotencyKey: `editorial:${created.postId}`,
    // Editorial can take several minutes. A claim that is lost to a restart
    // must not consume the whole budget before a worker finishes the poll.
    maxAttempts: 10,
  });

  return task;
}

function artifactOf(post: EditorialPost, locale: string): EditorialArtifact | null {
  return post.artifacts[locale] ?? Object.values(post.artifacts)[0] ?? null;
}

function claimCounts(artifact: EditorialArtifact) {
  return {
    supported: artifact.claims.filter((claim) => claim.verdict === "supported").length,
    removed: artifact.claims.filter((claim) => claim.verdict === "removed").length,
    unsupported: artifact.claims.filter((claim) => claim.verdict === "unsupported").length,
  };
}

/**
 * Move a running article task to review, failure or "not yet".
 *
 * Returns "waiting" while editorial is still working so the caller can defer
 * the job without spending an attempt.
 */
export async function reconcileEditorialArticleTask(
  agentTaskId: string,
): Promise<"waiting" | "review" | "failed"> {
  const task = await db.agentTask.findUnique({
    where: { id: agentTaskId },
    select: { id: true, kind: true, status: true, siteId: true, actionId: true, result: true },
  });
  if (!task || task.kind !== "wix_article") return "failed";
  if (task.status !== "RUNNING") return task.status === "AWAITING_REVIEW" ? "review" : "failed";

  const editorial = record(record(task.result).editorial);
  const postId = typeof editorial.post_id === "string" ? editorial.post_id : "";
  const locale = typeof editorial.locale === "string" ? editorial.locale : "en";
  const actionRevision = typeof record(task.result).action_revision === "number"
    ? record(task.result).action_revision
    : null;
  const storedIntent = record(task.result).intent;
  const intent = typeof storedIntent === "string" ? storedIntent : "informational";
  if (!postId) {
    await updateAgentTask(task.id, {
      status: "FAILED",
      errorCode: "EDITORIAL_POST_ID_MISSING",
      result: { ...record(task.result), editorialError: "The task has no editorial post id" } as never,
    });
    return "failed";
  }

  const post = await getEditorialPost(postId);
  if (!editorialTerminal(post.state)) {
    await updateAgentTask(task.id, {
      result: { ...record(task.result), editorial: { ...editorial, state: post.state } } as never,
    });
    return "waiting";
  }

  if (post.state === "held" || post.state === "failed" || post.state === "cancelled") {
    const reason = post.error || post.state;
    await updateAgentTask(task.id, {
      status: "FAILED",
      errorCode: `EDITORIAL_${post.state.toUpperCase()}`,
      result: {
        ...record(task.result),
        editorial: { ...editorial, state: post.state, error: reason },
        editorialError: reason,
      } as never,
    });
    await addAgentMessage(
      task.id,
      `Editorial ${post.state}: ${reason}. Nothing was drafted, so there is no review to approve.`,
      "SYSTEM",
    ).catch(() => undefined);
    return "failed";
  }

  const artifact = artifactOf(post, locale);
  if (!artifact) {
    await updateAgentTask(task.id, {
      status: "FAILED",
      errorCode: "EDITORIAL_ARTIFACT_MISSING",
      result: { ...record(task.result), editorial: { ...editorial, state: post.state } } as never,
    });
    return "failed";
  }

  const existing = await db.contentDraft.findFirst({
    where: { actionId: task.actionId ?? undefined, provider: "editorial" },
    orderBy: { createdAt: "desc" },
    select: { id: true, brief: true },
  });
  const alreadyStored = existing
    ? record(record(existing.brief).editorial).content_hash === artifact.content_hash
    : false;

  const draft = existing && alreadyStored
    ? existing
    : await db.contentDraft.create({
        data: {
          siteId: task.siteId,
          actionId: task.actionId,
          opportunityKey: task.actionId ?? post.id,
          actionKind: "article",
          format: "article",
          primaryQuery: artifact.primary_keyword,
          targetUrl: null,
          intent,
          title: artifact.title,
          slug: artifact.slug,
          metaTitle: artifact.meta_title,
          metaDescription: artifact.meta_description,
          excerpt: artifact.excerpt,
          markdown: artifact.body_markdown,
          outline: artifact.outline as unknown as Prisma.InputJsonValue,
          brief: {
            schema_version: 2,
            source: "editorial",
            action: { id: task.actionId, revision: actionRevision },
            editorial: {
              post_id: post.id,
              content_hash: artifact.content_hash,
              revision: artifact.revision,
              model: String(artifact.editorial?.model ?? ""),
              coverage: artifact.coverage,
              claims: claimCounts(artifact),
              sources: artifact.sources.map((source) => ({
                url: source.url,
                title: source.title,
                sha256: source.sha256,
              })),
            },
          } as Prisma.InputJsonValue,
          model: `editorial/${String(artifact.editorial?.model ?? "unknown")}`,
          provider: "editorial",
        },
      });

  await db.agentTask.update({
    where: { id: task.id },
    data: { draftId: draft.id, title: artifact.title, route: null },
  });
  await updateAgentTask(task.id, {
    status: "AWAITING_REVIEW",
    result: {
      ...record(task.result),
      editorial: {
        ...editorial,
        state: post.state,
        content_hash: artifact.content_hash,
        title: artifact.title,
        slug: artifact.slug,
        claims: claimCounts(artifact),
        sources: artifact.sources.map((source) => source.url),
      },
      draftId: draft.id,
    } as never,
  });
  await addAgentMessage(
    task.id,
    `Editorial finished at ${post.state}: ${artifact.title}. ` +
      `${claimCounts(artifact).supported} supported claim(s), ` +
      `${claimCounts(artifact).removed} removed, ${claimCounts(artifact).unsupported} unsupported.`,
    "SYSTEM",
  ).catch(() => undefined);

  return "review";
}
