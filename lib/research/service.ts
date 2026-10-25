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
import { emitConnectorEvent } from "@/lib/connectors/events";

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
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/https?:\/\/[^\s]+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  const target = input.targetUrl ? (() => { try { const url = new URL(input.targetUrl); url.hash = ""; url.search = ""; return `${url.origin.toLowerCase()}${url.pathname.replace(/\/$/, "")}`; } catch { return normalize(input.targetUrl!); } })() : "";
  const issue = normalize(input.primaryQuery ?? "") || normalize(input.title);
  return createHash("sha256")
    .update([
      input.kind,
      target,
      issue,
    ].join(":"))
    .digest("hex")
    .slice(0, 40);
}

function nearDuplicateTitle(left: string, right: string): boolean {
  const stop = new Set([
    "a", "an", "and", "article", "at", "build", "content", "create", "for", "from", "guide", "guidance",
    "how", "improve", "in", "information", "into", "make", "of", "on", "or", "page", "section", "the", "to",
    "update", "website", "with", "write",
  ]);
  const tokens = (value: string) => new Set(value.normalize("NFKC").toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.filter((word) => word.length > 2 && !stop.has(word)) ?? []);
  const a = tokens(left), b = tokens(right);
  if (!a.size || !b.size) return false;
  const intersection = [...a].filter((word) => b.has(word)).length;
  // A shared specific subject on the same target and Action kind is a useful
  // paraphrase signal even when the title verbs and framing differ. Requiring
  // overlap against the shorter informative title avoids merging unrelated
  // work merely because both mention a broad topic.
  return intersection >= 1 && intersection / Math.min(a.size, b.size) >= 0.5;
}

const ACTION_TRANSITIONS: Record<string, string[]> = {
  PROPOSED: ["APPROVED", "DISMISSED", "FAILED"],
  APPROVED: ["DRAFTING", "DISMISSED", "FAILED"],
  DRAFTING: ["DRAFT_READY", "FAILED"],
  DRAFT_READY: ["DELIVERY_APPROVED", "DRAFTING", "DISMISSED", "FAILED"],
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

export function researchMonthBounds(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const localMidnightUtc = (targetYear: number, targetMonth: number) => {
    const target = Date.UTC(targetYear, targetMonth - 1, 1);
    let guess = target;
    const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const formatted = Object.fromEntries(format.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
      const represented = Date.UTC(Number(formatted.year), Number(formatted.month) - 1, Number(formatted.day),
        Number(formatted.hour), Number(formatted.minute), Number(formatted.second));
      guess += target - represented;
    }
    return new Date(guess);
  };
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return { start: localMidnightUtc(year, month), end: localMidnightUtc(nextYear, nextMonth) };
}

export async function createResearchRun(
  siteId: string,
  input: CreateResearchRunInput,
  userId: string,
  scheduleKey?: string,
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

  let run: Awaited<ReturnType<typeof db.researchRun.create>>;
  try {
    run = await db.$transaction(async (tx) => {
      if (site.projectId) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${site.projectId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ResearchPolicy" WHERE "siteId" = ${siteId} FOR UPDATE`;
      const [policy, project] = await Promise.all([
        tx.researchPolicy.findUnique({ where: { siteId }, select: {
          monthlyBudget: true, revision: true, enabled: true, providers: true, recencyDays: true,
        } }),
        site.projectId ? tx.project.findUnique({ where: { id: site.projectId }, select: { researchBudgetTimeZone: true } }) : Promise.resolve(null),
      ]);
      if (policy?.enabled === false) throw new ResearchServiceError("Research is disabled by the current site policy", 409);
      const allowedProviders = Array.isArray(policy?.providers)
        ? policy.providers.filter((provider): provider is string => typeof provider === "string")
        : ["reddit", "news", "web"];
      const unsupported = input.providers.filter((provider) => !allowedProviders.includes(provider));
      if (unsupported.length) throw new ResearchServiceError(
        `Requested providers are outside the current site policy: ${unsupported.join(", ")}`, 409,
      );
      const effectiveRecencyDays = Math.min(input.recencyDays, Math.max(1, policy?.recencyDays ?? input.recencyDays));
      const budget = Math.max(0, policy?.monthlyBudget ?? 9);
      const now = new Date();
      const timeZone = project?.researchBudgetTimeZone ?? "UTC";
      const { start: monthStart, end: monthEnd } = researchMonthBounds(now, timeZone);
      if (scheduleKey) {
        const existing = await tx.researchRun.findUnique({ where: { siteId_scheduleKey: { siteId, scheduleKey } } });
        if (existing) return existing;
      }
      const used = await tx.researchRun.count({ where: { siteId, createdAt: { gte: monthStart, lt: monthEnd } } });
      if (used >= budget) throw new ResearchServiceError("Monthly research task budget is exhausted", 429);
      return tx.researchRun.create({
        data: {
          siteId,
          projectId: site.projectId,
          ...(scheduleKey ? { scheduleKey } : {}),
          kind: input.kind,
          trigger: input.trigger,
          title: input.title,
          brief: json({ ...brief, recency_days: effectiveRecencyDays }),
          topics: json(input.topics),
          recencyDays: effectiveRecencyDays,
          policyRevision: policy?.revision ?? 0,
          providerSet: json(input.providers),
          requestedBy: userId,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof ResearchServiceError) throw error;
    if ((error as { code?: string }).code === "P2034") throw new ResearchServiceError("Research budget changed concurrently; refresh and retry", 409);
    throw error;
  }

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

export async function getResearchRun(runId: string, siteId?: string) {
  const run = await db.researchRun.findFirst({
    where: { id: runId, ...(siteId ? { siteId } : {}) },
    include: {
      site: { select: { id: true, domain: true } },
      sources: { orderBy: { retrievedAt: "desc" }, take: 200 },
      findings: { orderBy: { createdAt: "asc" }, take: 200 },
      actions: {
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        take: 200,
        include: { finding: { select: { evidenceSourceIds: true } } },
      },
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
  const merge = (left: unknown, right: unknown): unknown => {
    if (Array.isArray(left) || Array.isArray(right)) {
      const values = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])];
      const seen = new Set<string>();
      return values.filter((value) => {
        const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
        const identity = record && [record.id, record.source_id, record.url, record.key].find((part) => typeof part === "string" && part)
          ? String([record.id, record.source_id, record.url, record.key].find((part) => typeof part === "string" && part))
          : JSON.stringify(value);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    }
    if (left && right && typeof left === "object" && typeof right === "object") {
      const result: Record<string, unknown> = { ...(left as Record<string, unknown>) };
      for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
        result[key] = key in result ? merge(result[key], value) : value;
      }
      return result;
    }
    return right ?? left;
  };
  const result = merge(base, added) as Record<string, unknown>;
  const runIds = [
    ...(Array.isArray(base.research_run_ids) ? base.research_run_ids : []),
    base.research_run_id,
    ...(Array.isArray(added.research_run_ids) ? added.research_run_ids : []),
    added.research_run_id,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  if (runIds.length) result.research_run_ids = [...new Set(runIds)];
  return json(result);
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
          type: true,
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

  const stableIssue = finding?.theme || input.primaryQuery || input.title;
  const dedupeKey = input.dedupeKey ?? researchActionDedupeKey({
    ...input, primaryQuery: stableIssue, title: stableIssue,
  });
  const existing = await db.researchAction.findUnique({
    where: { siteId_dedupeKey: { siteId, dedupeKey } },
  });
  const terminalStatuses = new Set(["DISMISSED", "VERIFIED", "FAILED"]);
  if (existing && terminalStatuses.has(existing.status)) return { action: existing, created: false };

  // Merge the same open work item across sources (market research, keyword
  // research, GSC, crawl) instead of creating parallel queues.
  const openConflicts = await db.researchAction.findMany({
    where: {
      siteId,
      status: { notIn: ["DISMISSED", "VERIFIED", "FAILED"] },
      kind: input.kind,
      targetUrl: input.targetUrl ?? null,
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const normalizedQuery = input.primaryQuery?.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedTarget = (value: string | null | undefined) => {
    if (!value) return "";
    try { const url = new URL(value); url.search = ""; url.hash = ""; return url.toString().replace(/\/$/, "").toLowerCase(); }
    catch { return value.trim().toLowerCase(); }
  };
  const openConflict = (existing && !terminalStatuses.has(existing.status) ? existing : null) ?? openConflicts.find((candidate) => {
    if (normalizedTarget(candidate.targetUrl) !== normalizedTarget(input.targetUrl)) return false;
    if (normalizedQuery && candidate.primaryQuery?.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim() === normalizedQuery) return true;
    return nearDuplicateTitle(candidate.title, input.title);
  });
  if (openConflict) {
    const merged = await db.$transaction(async (tx) => {
      const current = await tx.researchAction.findUnique({ where: { id: openConflict.id } });
      if (!current) throw new ResearchServiceError("The matching Action disappeared during deduplication", 409);
      if (current.revision !== openConflict.revision) {
        throw new ResearchServiceError("The matching Action changed during deduplication; refresh before retrying", 409);
      }
      const execution = await tx.connectorExecutionState.findUnique({
        where: { actionId_actionRevision: { actionId: current.id, actionRevision: current.revision } },
        select: { status: true, ownerDecision: true },
      });
      // Keep a candidate immutable while the owner is reviewing or after an
      // exact decision. New evidence stays on its finding and can be
      // reassessed after this execution is terminal.
      if (current.preparationStatus === "ELIGIBLE" || current.preparationStatus === "QUEUED"
          || current.preparationStatus === "READY" || execution?.ownerDecision
          || execution?.status === "preparation_ready") {
        return { action: current, created: false, merged: false, protected: true };
      }
      const mergedEvidence = mergeActionEvidence(current.evidence, input.evidence);
      const evidenceChanged = JSON.stringify(current.evidence ?? {}) !== JSON.stringify(mergedEvidence);
      const priorityChanged = input.priority !== current.priority;
      const titleChanged = current.title !== input.title;
      const recommendationChanged = current.recommendation !== input.recommendation;
      const queryChanged = (current.primaryQuery ?? null) !== (input.primaryQuery ?? null);
      const linkRun = Boolean(input.runId && !current.runId);
      const linkFinding = Boolean(input.findingId && !current.findingId);
      if (!evidenceChanged && !priorityChanged && !titleChanged && !recommendationChanged
          && !queryChanged && !linkRun && !linkFinding) {
        return { action: current, created: false, merged: false, protected: true };
      }
      const updated = await tx.researchAction.update({
        where: { id: current.id },
        data: {
          revision: { increment: 1 },
          preparationStatus: "NONE",
          preparationRequestId: null,
          status: "PROPOSED",
          title: input.title,
          primaryQuery: input.primaryQuery,
          recommendation: input.recommendation,
          priority: input.priority,
          evidence: mergedEvidence,
          ...(linkRun ? { runId: input.runId } : {}),
          ...(linkFinding ? { findingId: input.findingId } : {}),
        },
      });
      if (site.projectId) await recordResearchActionEvent(tx, updated, site.projectId, "action.updated");
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return "protected" in merged
      ? { action: merged.action, created: false, merged: false }
      : { action: merged, created: false, merged: true };
  }

  const rawEvidence = input.evidence ?? (finding
    ? {
        finding_id: finding.id,
        theme: finding.theme,
        summary: finding.summary,
        confidence: finding.confidence,
        source_ids: finding.evidenceSourceIds,
      }
    : undefined);
  const evidence = rawEvidence || finding ? {
    ...(rawEvidence && typeof rawEvidence === "object" && !Array.isArray(rawEvidence)
      ? rawEvidence as Record<string, unknown> : {}),
    ...(finding ? { finding_refs: [{ id: finding.id, run_id: finding.runId, type: finding.type,
      theme: finding.theme, summary: finding.summary, confidence: finding.confidence,
      source_ids: finding.evidenceSourceIds }] } : {}),
  } : undefined;

  const action = await db.$transaction(async (tx) => {
    const created = await tx.researchAction.create({ data: {
      siteId,
      projectId: site.projectId,
      runId: input.runId ?? finding?.runId ?? null,
      findingId: finding?.id ?? null,
      source: input.source,
      kind: input.kind,
      format: input.format,
      title: input.title,
      primaryQuery: input.primaryQuery,
      targetUrl: input.targetUrl,
      recommendation: input.recommendation,
      priorityRationale: input.priorityRationale,
      evidence: evidence ? json(evidence) : undefined,
      requiredCapabilities: input.requiredCapabilities ? json(input.requiredCapabilities) : undefined,
      acceptanceCriteria: input.acceptanceCriteria ? json(input.acceptanceCriteria) : undefined,
      dependencies: input.dependencies ? json(input.dependencies) : undefined,
      reassessmentConditions: input.reassessmentConditions ? json(input.reassessmentConditions) : undefined,
      priority: input.priority,
      automationMode: input.automationMode,
      dedupeKey,
      owner: userId,
    } });
    if (created.runId) await tx.researchRun.update({ where: { id: created.runId }, data: { actionCount: { increment: 1 } } });
    if (site.projectId) await recordResearchActionEvent(tx, created, site.projectId, "action.created");
    return created;
  });

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
    select: { id: true, siteId: true, projectId: true, revision: true, status: true,
      site: { select: { connectorBinding: { select: { executor: true, status: true } } } } },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);

  if (action.site.connectorBinding?.status === "ACTIVE" && action.site.connectorBinding.executor === "helloada"
    && ["APPROVED", "DELIVERY_APPROVED"].includes(input.status ?? "")) {
    throw new ResearchServiceError("HelloAda owns exact owner approval for this site", 409);
  }

  if (input.status && !canTransitionActionStatus(action.status, input.status)) {
    throw new ResearchServiceError(
      `Cannot move action from ${action.status} to ${input.status}`,
      409,
    );
  }

  const now = new Date();
  const updated = await db.$transaction(async (tx) => {
    const next = await tx.researchAction.update({ where: { id: actionId }, data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.automationMode ? { automationMode: input.automationMode } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.status === "APPROVED"
        ? { approvedBy: userId, approvedAt: now }
        : {}),
      ...(input.status === "DELIVERED" ? { deliveredAt: now } : {}),
      ...(input.status === "VERIFIED" ? { verifiedAt: now } : {}),
    } });
    if (action.projectId) await recordResearchActionEvent(tx, next, action.projectId, "action.updated");
    return next;
  });
  return updated;
}

async function recordResearchActionEvent(
  tx: Prisma.TransactionClient,
  action: { id: string; siteId: string; revision: number; title: string; recommendation: string; status: string; priority: number },
  projectId: string,
  type: string,
) {
  await emitConnectorEvent(tx, {
    projectId,
    siteId: action.siteId,
    actionId: action.id,
    actionRevision: action.revision,
    type,
    payload: { actionId: action.id, revision: action.revision, title: action.title,
      recommendation: action.recommendation, status: action.status.toLowerCase(), priority: action.priority },
  });
}
