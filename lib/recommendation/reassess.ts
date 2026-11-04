import type { PrismaClient } from "@prisma/client";

import { contentWriterConfigured } from "@/lib/ai-seo/writer";
import { parsePersistedDecision, type RecommendationDecision } from "@/lib/recommendation/contracts";
import { buildEvidencePacket } from "@/lib/recommendation/packet";
import { assessFinding, findReusableDecision, type AssessmentRunDb, type FindingForAssessment } from "@/lib/recommendation/run";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import type { assessRecommendation } from "@/lib/recommendation/assess";

/**
 * Reassess every active research finding, not only the findings a new run created.
 *
 * Reuse is keyed to the sealed packet, so an unchanged page, source, business fact,
 * prompt and model cost nothing. A changed dependency invalidates the old decision
 * even when the finding's sentence did not change.
 */

export type ReassessDb = AssessmentRunDb &
  Pick<PrismaClient, "researchFinding" | "evidenceRecord" | "opportunity" | "rawProviderResponse">;

export type ReassessOutcome = {
  findingId: string;
  theme: string;
  status: "current" | "stale" | "missing" | "assessed" | "reused" | "failed" | "no_decision" | "skipped";
  readiness: string | null;
  reason?: string;
};

export type ReassessResult = {
  findings: number;
  current: number;
  stale: number;
  missing: number;
  assessed: number;
  reused: number;
  failed: number;
  skipped: number;
  outcomes: ReassessOutcome[];
};

function findingFor(row: {
  findingId: string;
  runId: string;
  type: string;
  theme: string;
  summary: string;
  observedAt: Date;
  sourceIds: string[];
  dedupKey: string;
  dimensions: Record<string, string | number | boolean | null>;
}): FindingForAssessment {
  return {
    id: row.findingId,
    runId: row.runId,
    type: row.type,
    theme: row.theme,
    summary: row.summary,
    premise: row.summary,
    observedAt: row.observedAt,
    sourceIds: row.sourceIds,
    dedupKey: row.dedupKey,
    dimensions: row.dimensions,
  };
}

export async function reassessProjectRecommendations(
  db: ReassessDb,
  opts: {
    projectId: string;
    siteId: string;
    dryRun?: boolean;
    maxAssessments?: number;
    assessor?: typeof assessRecommendation;
    /** Shared across candidates so one run has one budget. */
    ledger?: AnalysisLedger;
  }
): Promise<ReassessResult> {
  const result: ReassessResult = {
    findings: 0,
    current: 0,
    stale: 0,
    missing: 0,
    assessed: 0,
    reused: 0,
    failed: 0,
    skipped: 0,
    outcomes: [],
  };

  // Oldest first: a stable cursor gives later candidates a turn instead of
  // re-checking the same first rows forever.
  const rows = await db.evidenceRecord.findMany({
    where: { projectId: opts.projectId, siteId: opts.siteId, kind: "research_finding", supersededById: null },
    select: { id: true, dimensions: true, observedAt: true },
    orderBy: { observedAt: "asc" },
  });

  const maxAssessments = Math.max(0, Math.min(opts.maxAssessments ?? 6, 12));
  const ledger = opts.ledger ?? new AnalysisLedger();
  const model = opts.assessor ? null : contentWriterConfig()?.model ?? null;
  let attempts = 0;

  for (const row of rows) {
    const dimensions = (row.dimensions ?? {}) as Record<string, unknown>;
    if (dimensions.painPoint !== "true" && dimensions.positioningGap !== "true") continue;
    const findingId = typeof dimensions.findingId === "string" ? dimensions.findingId : null;
    if (!findingId) {
      result.skipped += 1;
      result.outcomes.push({ findingId: row.id, theme: "unknown", status: "skipped", readiness: null, reason: "no finding identity" });
      continue;
    }
    const stored = await db.researchFinding.findUnique({
      where: { id: findingId },
      select: { id: true, runId: true, type: true, theme: true, summary: true, evidenceSourceIds: true, createdAt: true },
    });
    if (!stored) {
      result.skipped += 1;
      result.outcomes.push({ findingId, theme: String(dimensions.theme ?? ""), status: "skipped", readiness: null, reason: "research finding row is missing" });
      continue;
    }

    result.findings += 1;
    const sourceIds = Array.isArray(stored.evidenceSourceIds)
      ? stored.evidenceSourceIds.filter((value): value is string => typeof value === "string")
      : [];
    const candidate = findingFor({
      findingId: stored.id,
      runId: stored.runId,
      type: stored.type,
      theme: stored.theme,
      summary: String(dimensions.painPointSummary ?? dimensions.gapSummary ?? stored.summary),
      observedAt: stored.createdAt,
      sourceIds,
      dedupKey: typeof dimensions.recommendationDedupKey === "string"
        ? dimensions.recommendationDedupKey
        : `${stored.type.toUpperCase().includes("POSITION") ? "O14" : "O13"}:${stored.id}`,
      dimensions: dimensions as Record<string, string | number | boolean | null>,
    });

    if (opts.dryRun) {
      const packet = await buildEvidencePacket(db, {
        projectId: opts.projectId,
        siteId: opts.siteId,
        candidate: {
          findingId: candidate.id,
          dedupKey: candidate.dedupKey,
          findingType: candidate.type,
          theme: candidate.theme,
          summary: candidate.summary,
          premise: candidate.premise,
          observedAt: candidate.observedAt,
          sourceIds: candidate.sourceIds,
        },
      });
      const existing = parsePersistedDecision(dimensions.recommendationDecisionJson);
      const status = !existing ? "missing" : existing.packetHash === packet.packetHash ? "current" : "stale";
      if (status === "current") result.current += 1;
      if (status === "stale") result.stale += 1;
      if (status === "missing") result.missing += 1;
      result.outcomes.push({
        findingId: candidate.id,
        theme: candidate.theme,
        status,
        readiness: existing?.readiness ?? null,
      });
      continue;
    }

    // Reuse is checked before the budget: an unchanged candidate costs a packet
    // build, not a model call, and must not starve a stale candidate behind it.
    const currentPacket = await buildEvidencePacket(db, {
      projectId: opts.projectId,
      siteId: opts.siteId,
      candidate: {
        findingId: candidate.id,
        dedupKey: candidate.dedupKey,
        findingType: candidate.type,
        theme: candidate.theme,
        summary: candidate.summary,
        premise: candidate.premise,
        observedAt: candidate.observedAt,
        sourceIds: candidate.sourceIds,
      },
    });
    const reusable = findReusableDecision(dimensions, currentPacket, model);
    if (reusable) {
      result.reused += 1;
      result.outcomes.push({
        findingId: candidate.id,
        theme: candidate.theme,
        status: "reused",
        readiness: reusable.readiness,
      });
      continue;
    }

    if (!contentWriterConfigured() && !opts.assessor) {
      result.skipped += 1;
      result.outcomes.push({
        findingId: candidate.id,
        theme: candidate.theme,
        status: "skipped",
        readiness: null,
        reason: "no model is configured for reassessment",
      });
      continue;
    }
    if (attempts >= maxAssessments) {
      result.skipped += 1;
      result.outcomes.push({
        findingId: candidate.id,
        theme: candidate.theme,
        status: "skipped",
        readiness: null,
        reason: "assessment budget exhausted",
      });
      continue;
    }

    attempts += 1;
    const assessed = await assessFinding(db, {
      projectId: opts.projectId,
      siteId: opts.siteId,
      finding: candidate,
      assessor: opts.assessor,
      ledger,
    });
    if (assessed.status === "reused") result.reused += 1;
    else if (assessed.status === "assessed") result.assessed += 1;
    else if (assessed.status === "failed") result.failed += 1;
    else if (assessed.status === "no_decision") result.failed += 1;
    result.outcomes.push({
      findingId: candidate.id,
      theme: candidate.theme,
      status: assessed.status,
      readiness: assessed.decision?.readiness ?? null,
      reason: assessed.errors.join("; ").slice(0, 400) || undefined,
    });
  }

  return result;
}
