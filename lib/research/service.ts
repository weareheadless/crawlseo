import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { ResearchActionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobKind } from "@prisma/client";
import type {
  CreateResearchActionInput,
  CreateResearchRunInput,
  IngestResearchFindingInput,
  ResearchSourceInput,
  UpdateResearchActionInput,
} from "@/lib/research/types";

export class ResearchServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ResearchServiceError";
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function researchActionDedupeKey(input: {
  source: string;
  kind: string;
  targetUrl?: string | null;
  primaryQuery?: string | null;
  title: string;
}): string {
  return createHash("sha256")
    .update([
      input.source,
      input.kind,
      input.targetUrl ?? "",
      input.primaryQuery ?? "",
      input.title.trim().toLowerCase(),
    ].join(":"))
    .digest("hex")
    .slice(0, 40);
}

const ACTION_TRANSITIONS: Record<string, string[]> = {
  PROPOSED: ["APPROVED", "DISMISSED", "FAILED"],
  APPROVED: ["DRAFTING", "DISMISSED", "FAILED"],
  DRAFTING: ["DRAFT_READY", "FAILED"],
  DRAFT_READY: ["DELIVERY_APPROVED", "DRAFTING", "FAILED"],
  DELIVERY_APPROVED: ["DELIVERING", "FAILED"],
  DELIVERING: ["DELIVERED", "FAILED"],
  DELIVERED: ["VERIFIED", "FAILED"],
  DISMISSED: [],
  VERIFIED: [],
  FAILED: [],
};

export function canTransitionActionStatus(from: string, to: string): boolean {
  if (from === to) return true;
  return (ACTION_TRANSITIONS[from] ?? []).includes(to);
}

export async function createResearchRun(
  siteId: string,
  input: CreateResearchRunInput,
  userId: string,
) {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, projectId: true },
  });
  if (!site) throw new ResearchServiceError("Site not found", 404);

  const brief = {
    topics: input.topics,
    audience: input.audience ?? null,
    market: input.market ?? null,
    language: input.language,
    questions: input.questions,
    providers: input.providers,
    recency_days: input.recencyDays,
  };

  const run = await db.researchRun.create({
    data: {
      siteId,
      projectId: site.projectId,
      kind: input.kind,
      trigger: input.trigger,
      title: input.title,
      brief: json(brief),
      topics: json(input.topics),
      recencyDays: input.recencyDays,
      providerSet: json(input.providers),
      requestedBy: userId,
    },
    include: { _count: { select: { sources: true, findings: true, actions: true } } },
  });

  try {
    await enqueueJob({
      projectId: site.projectId,
      siteId,
      kind: JobKind.RESEARCH_RUN,
      payload: { researchRunId: run.id },
      idempotencyKey: `research-run:${run.id}`,
      maxAttempts: 3,
    });
  } catch {
    await db.researchRun.update({
      where: { id: run.id },
      data: { status: "FAILED", errorCode: "RESEARCH_JOB_ENQUEUE_FAILED", completedAt: new Date() },
    });
    throw new ResearchServiceError("Failed to queue research run", 500);
  }

  return run;
}

export async function listResearchRuns(siteId: string, limit = 20) {
  return db.researchRun.findMany({
    where: { siteId },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 100)),
    include: { _count: { select: { sources: true, findings: true, actions: true } } },
  });
}

export async function getResearchRun(runId: string) {
  const run = await db.researchRun.findUnique({
    where: { id: runId },
    include: {
      site: { select: { id: true, domain: true } },
      sources: { orderBy: { retrievedAt: "desc" }, take: 200 },
      findings: { orderBy: { createdAt: "asc" }, take: 200 },
      actions: { orderBy: [{ priority: "desc" }, { createdAt: "desc" }], take: 200 },
    },
  });
  if (!run) throw new ResearchServiceError("Research run not found", 404);
  return run;
}

export async function ingestResearchFinding(
  runId: string,
  input: IngestResearchFindingInput,
) {
  const run = await db.researchRun.findUnique({
    where: { id: runId },
    select: { id: true, siteId: true },
  });
  if (!run) throw new ResearchServiceError("Research run not found", 404);

  return db.$transaction(async (tx) => {
    const sourceIds: string[] = [];
    let createdSources = 0;

    for (const source of input.sources) {
      if (source.contentHash) {
        const existing = await tx.researchSource.findFirst({
          where: { runId, contentHash: source.contentHash },
          select: { id: true },
        });
        if (existing) {
          sourceIds.push(existing.id);
          continue;
        }
      }
      const created = await tx.researchSource.create({
        data: {
          runId,
          provider: source.provider,
          url: source.url,
          title: source.title,
          author: source.author,
          community: source.community,
          publishedAt: source.publishedAt ? new Date(source.publishedAt) : undefined,
          excerpt: source.excerpt,
          contentHash: source.contentHash,
          language: source.language,
          metadata: source.metadata ? json(source.metadata) : undefined,
        },
        select: { id: true },
      });
      sourceIds.push(created.id);
      createdSources += 1;
    }

    const finding = await tx.researchFinding.create({
      data: {
        runId,
        type: input.type,
        theme: input.theme,
        summary: input.summary,
        confidence: input.confidence,
        sentiment: input.sentiment,
        urgency: input.urgency,
        evidenceSourceIds: json(sourceIds),
        suggestedActionKind: input.suggestedActionKind,
      },
    });

    await tx.researchRun.update({
      where: { id: runId },
      data: {
        sourceCount: { increment: createdSources },
        findingCount: { increment: 1 },
      },
    });

    return finding;
  });
}

export async function saveResearchSources(
  runId: string,
  sources: ResearchSourceInput[],
) {
  const run = await db.researchRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });
  if (!run) throw new ResearchServiceError("Research run not found", 404);

  return db.$transaction(async (tx) => {
    const saved: Array<{
      id: string;
      provider: string;
      url: string;
      title: string | null;
      community: string | null;
      publishedAt: Date | null;
      excerpt: string | null;
      contentHash: string | null;
    }> = [];
    let created = 0;

    for (const source of sources) {
      const existing = source.contentHash
        ? await tx.researchSource.findFirst({
            where: { runId, contentHash: source.contentHash },
            select: { id: true, provider: true, url: true, title: true, community: true, publishedAt: true, excerpt: true, contentHash: true },
          })
        : await tx.researchSource.findFirst({
            where: { runId, url: source.url },
            select: { id: true, provider: true, url: true, title: true, community: true, publishedAt: true, excerpt: true, contentHash: true },
          });
      if (existing) {
        saved.push(existing);
        continue;
      }
      const row = await tx.researchSource.create({
        data: {
          runId,
          provider: source.provider,
          url: source.url,
          title: source.title,
          author: source.author,
          community: source.community,
          publishedAt: source.publishedAt ? new Date(source.publishedAt) : undefined,
          excerpt: source.excerpt,
          contentHash: source.contentHash,
          language: source.language,
          metadata: source.metadata ? json(source.metadata) : undefined,
        },
        select: { id: true, provider: true, url: true, title: true, community: true, publishedAt: true, excerpt: true, contentHash: true },
      });
      saved.push(row);
      created += 1;
    }

    if (created > 0) {
      await tx.researchRun.update({
        where: { id: runId },
        data: { sourceCount: { increment: created } },
      });
    }
    return saved;
  });
}

export async function createResearchFinding(
  runId: string,
  input: {
    type: IngestResearchFindingInput["type"];
    theme: string;
    summary: string;
    confidence: number;
    sentiment?: string;
    urgency?: string;
    suggestedActionKind?: string;
  },
  sourceIds: string[],
) {
  if (sourceIds.length === 0) {
    throw new ResearchServiceError("A research finding requires at least one source", 400);
  }

  const existing = await db.researchFinding.findFirst({
    where: { runId, type: input.type, theme: input.theme },
  });
  if (existing) return existing;

  return db.$transaction(async (tx) => {
    const finding = await tx.researchFinding.create({
      data: {
        runId,
        type: input.type,
        theme: input.theme,
        summary: input.summary,
        confidence: input.confidence,
        sentiment: input.sentiment,
        urgency: input.urgency,
        evidenceSourceIds: json(sourceIds),
        suggestedActionKind: input.suggestedActionKind,
      },
    });
    await tx.researchRun.update({
      where: { id: runId },
      data: { findingCount: { increment: 1 } },
    });
    return finding;
  });
}

function mergeActionEvidence(
  existing: Prisma.JsonValue | null,
  incoming: unknown,
): Prisma.InputJsonValue {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  const added = incoming && typeof incoming === "object" && !Array.isArray(incoming)
    ? incoming as Record<string, unknown>
    : {};
  return json({ ...base, ...added, merged_at: new Date().toISOString() });
}

export async function createResearchAction(
  siteId: string,
  input: CreateResearchActionInput,
  userId: string,
) {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, projectId: true },
  });
  if (!site) throw new ResearchServiceError("Site not found", 404);

  if (input.runId) {
    const run = await db.researchRun.findFirst({
      where: { id: input.runId, siteId },
      select: { id: true },
    });
    if (!run) throw new ResearchServiceError("Research run not found for this site", 404);
  }

  const finding = input.findingId
    ? await db.researchFinding.findFirst({
        where: {
          id: input.findingId,
          ...(input.runId ? { runId: input.runId } : {}),
        },
        select: {
          id: true,
          theme: true,
          summary: true,
          confidence: true,
          evidenceSourceIds: true,
          runId: true,
        },
      })
    : null;
  if (input.findingId && !finding) {
    throw new ResearchServiceError("Research finding not found", 404);
  }
  if (finding && input.runId && finding.runId !== input.runId) {
    throw new ResearchServiceError("Finding does not belong to this research run", 400);
  }

  const dedupeKey = input.dedupeKey ?? researchActionDedupeKey(input);
  const existing = await db.researchAction.findUnique({
    where: { siteId_dedupeKey: { siteId, dedupeKey } },
  });
  if (existing) return { action: existing, created: false };

  // Merge the same open work item across sources (market research, keyword
  // research, GSC, crawl) instead of creating parallel queues.
  const openConflict = await db.researchAction.findFirst({
    where: {
      siteId,
      status: { notIn: ["DISMISSED", "VERIFIED", "FAILED"] },
      kind: input.kind,
      targetUrl: input.targetUrl ?? null,
      ...(input.primaryQuery
        ? { primaryQuery: input.primaryQuery }
        : { title: input.title }),
    },
    orderBy: { createdAt: "asc" },
  });
  if (openConflict) {
    const merged = await db.researchAction.update({
      where: { id: openConflict.id },
      data: {
        priority: Math.max(openConflict.priority, input.priority),
        evidence: mergeActionEvidence(openConflict.evidence, input.evidence),
        ...(input.runId && !openConflict.runId ? { runId: input.runId } : {}),
        ...(input.findingId && !openConflict.findingId ? { findingId: input.findingId } : {}),
      },
    });
    return { action: merged, created: false, merged: true };
  }

  const evidence = input.evidence ?? (finding
    ? {
        finding_id: finding.id,
        theme: finding.theme,
        summary: finding.summary,
        confidence: finding.confidence,
        source_ids: finding.evidenceSourceIds,
      }
    : undefined);

  const action = await db.researchAction.create({
    data: {
      siteId,
      runId: input.runId ?? finding?.runId ?? null,
      findingId: finding?.id ?? null,
      source: input.source,
      kind: input.kind,
      format: input.format,
      title: input.title,
      primaryQuery: input.primaryQuery,
      targetUrl: input.targetUrl,
      recommendation: input.recommendation,
      evidence: evidence ? json(evidence) : undefined,
      priority: input.priority,
      automationMode: input.automationMode,
      dedupeKey,
      owner: userId,
    },
  });

  if (action.runId) {
    await db.researchRun.update({
      where: { id: action.runId },
      data: { actionCount: { increment: 1 } },
    });
  }

  return { action, created: true };
}

export async function listResearchActions(
  siteId: string,
  options: { status?: string; limit?: number } = {},
) {
  const status = options.status?.trim().toUpperCase();
  return db.researchAction.findMany({
    where: {
      siteId,
      ...(status ? { status: status as ResearchActionStatus } : {}),
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: Math.max(1, Math.min(options.limit ?? 50, 200)),
    include: { _count: { select: { drafts: true, deliveries: true } } },
  });
}

export async function updateResearchAction(
  actionId: string,
  input: UpdateResearchActionInput,
  userId: string,
) {
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    select: { id: true, status: true },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);

  if (input.status && !canTransitionActionStatus(action.status, input.status)) {
    throw new ResearchServiceError(
      `Cannot move action from ${action.status} to ${input.status}`,
      409,
    );
  }

  const now = new Date();
  return db.researchAction.update({
    where: { id: actionId },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.automationMode ? { automationMode: input.automationMode } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.status === "APPROVED"
        ? { approvedBy: userId, approvedAt: now }
        : {}),
      ...(input.status === "DELIVERED" ? { deliveredAt: now } : {}),
      ...(input.status === "VERIFIED" ? { verifiedAt: now } : {}),
    },
  });
}
