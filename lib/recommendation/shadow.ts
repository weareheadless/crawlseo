import { writeFileSync } from "node:fs";

import type { PrismaClient } from "@prisma/client";

import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { buildEvidencePacket, type PacketDb } from "@/lib/recommendation/packet";
import { assessFinding, findReusableDecision, type FindingForAssessment } from "@/lib/recommendation/run";
import type { assessRecommendation } from "@/lib/recommendation/assess";
import { parsePersistedDecision, type RecommendationDecision } from "@/lib/recommendation/contracts";

/**
 * Shadow analysis: run the same retrieval, model, validation and projection as a
 * published reassessment, but write only to an explicit JSON artifact.
 *
 * This is not a hash-freshness check. It produces the proposed decisions a reviewer
 * would compare before an apply, including additions, changes, removals, unchanged
 * rows and failures. Nothing in the application database is written.
 */

export type ShadowDb = PacketDb &
  Pick<PrismaClient, "researchFinding" | "evidenceRecord" | "opportunity" | "rawProviderResponse" | "evidenceEdge">;

export type ShadowEntry = {
  findingId: string;
  theme: string;
  status: "added" | "changed" | "unchanged" | "removed" | "failed" | "blocked";
  currentReadiness: string | null;
  proposedReadiness: string | null;
  currentIntervention: string | null;
  proposedIntervention: string | null;
  change: string | null;
  investigationQuestion: string | null;
  reason: string | null;
};

export type ShadowReport = {
  schemaVersion: "recommendation-shadow/1";
  generatedAt: string;
  domain: string;
  projectId: string;
  siteId: string;
  model: string | null;
  totals: Record<ShadowEntry["status"], number>;
  entries: ShadowEntry[];
};

function summary(decision: RecommendationDecision | null): {
  readiness: string | null;
  intervention: string | null;
  change: string | null;
  investigation: string | null;
} {
  if (!decision) return { readiness: null, intervention: null, change: null, investigation: null };
  return {
    readiness: decision.readiness,
    intervention: decision.intervention,
    change: decision.change,
    investigation: decision.investigation?.question ?? null,
  };
}

export async function shadowRecommendations(
  db: ShadowDb,
  opts: {
    projectId: string;
    siteId: string;
    outPath?: string;
    maxAssessments?: number;
    assessor?: typeof assessRecommendation;
    ledger?: AnalysisLedger;
  }
): Promise<ShadowReport> {
  const site = await db.site.findUnique({ where: { id: opts.siteId }, select: { domain: true, projectId: true } });
  if (!site || site.projectId !== opts.projectId) throw new Error("shadow site does not belong to the project");
  const ledger = opts.ledger ?? new AnalysisLedger();
  const model = opts.assessor ? null : contentWriterConfig()?.model ?? null;
  const rows = await db.evidenceRecord.findMany({
    where: { projectId: opts.projectId, siteId: opts.siteId, kind: "research_finding", supersededById: null },
    select: { id: true, dimensions: true, observedAt: true },
    orderBy: { observedAt: "asc" },
  });
  const existing = await db.opportunity.findMany({
    where: { projectId: opts.projectId, status: "detected" },
    select: { dedupKey: true, status: true },
  });
  const detectedKeys = new Set(existing.map((row) => row.dedupKey));

  const maxAssessments = Math.max(0, Math.min(opts.maxAssessments ?? 8, 12));
  let attempts = 0;
  const entries: ShadowEntry[] = [];

  for (const row of rows) {
    const dimensions = (row.dimensions ?? {}) as Record<string, unknown>;
    if (dimensions.painPoint !== "true" && dimensions.positioningGap !== "true") continue;
    const findingId = typeof dimensions.findingId === "string" ? dimensions.findingId : null;
    if (!findingId) {
      entries.push({
        findingId: row.id,
        theme: String(dimensions.theme ?? "(no theme)"),
        status: "blocked",
        currentReadiness: null,
        proposedReadiness: null,
        currentIntervention: null,
        proposedIntervention: null,
        change: null,
        investigationQuestion: null,
        reason: "evidence row has no finding identity",
      });
      continue;
    }
    const stored = await db.researchFinding.findUnique({
      where: { id: findingId },
      select: { id: true, runId: true, type: true, theme: true, summary: true, evidenceSourceIds: true, createdAt: true },
    });
    if (!stored) {
      entries.push({
        findingId,
        theme: String(dimensions.theme ?? ""),
        status: "blocked",
        currentReadiness: null,
        proposedReadiness: null,
        currentIntervention: null,
        proposedIntervention: null,
        change: null,
        investigationQuestion: null,
        reason: "research finding row is missing",
      });
      continue;
    }
    const sourceIds = Array.isArray(stored.evidenceSourceIds)
      ? stored.evidenceSourceIds.filter((value): value is string => typeof value === "string")
      : [];
    const dedupKey = typeof dimensions.recommendationDedupKey === "string"
      ? dimensions.recommendationDedupKey
      : `${stored.type.toUpperCase().includes("POSITION") ? "O14" : "O13"}:${stored.id}`;
    const candidate: FindingForAssessment = {
      id: stored.id,
      runId: stored.runId,
      type: stored.type,
      theme: stored.theme,
      summary: String(dimensions.painPointSummary ?? dimensions.gapSummary ?? stored.summary),
      premise: String(dimensions.painPointSummary ?? dimensions.gapSummary ?? stored.summary),
      observedAt: stored.createdAt,
      sourceIds,
      dedupKey,
      dimensions: dimensions as Record<string, string | number | boolean | null>,
    };
    const packet = await buildEvidencePacket(db, {
      projectId: opts.projectId,
      siteId: opts.siteId,
      maxLiveFetches: 0,
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
    const current = parsePersistedDecision(dimensions.recommendationDecisionJson);
    const reusable = findReusableDecision(dimensions, packet, model);

    let proposed: RecommendationDecision | null = null;
    let failure: string | null = null;
    if (reusable) {
      proposed = reusable;
    } else if (attempts >= maxAssessments) {
      failure = "shadow assessment budget exhausted";
    } else if (!contentWriterConfig() && !opts.assessor) {
      failure = "no model is configured for shadow analysis";
    } else {
      attempts += 1;
      const assessed = await assessFinding(db, {
        projectId: opts.projectId,
        siteId: opts.siteId,
        finding: candidate,
        persist: false,
        force: true,
        assessor: opts.assessor,
        ledger,
      });
      proposed = assessed.decision;
      if (!proposed) failure = assessed.errors.join("; ").slice(0, 500) || "assessment failed";
    }

    const before = summary(current);
    const after = summary(proposed);
    let status: ShadowEntry["status"];
    if (failure) status = "failed";
    else if (!current && proposed) status = after.readiness === "rejected" || after.readiness === "no_action" ? "unchanged" : "added";
    else if (current && !proposed) status = "removed";
    else if (current && proposed) {
      const changed =
        before.readiness !== after.readiness ||
        before.intervention !== after.intervention ||
        before.change !== after.change ||
        before.investigation !== after.investigation;
      status = changed ? "changed" : "unchanged";
    } else status = "unchanged";

    // A previously published row that the proposed decision would reject is a
    // removal, not an unchanged rejection.
    if (!failure && (after.readiness === "rejected" || after.readiness === "no_action") && detectedKeys.has(dedupKey)) {
      status = "removed";
    }

    entries.push({
      findingId: candidate.id,
      theme: candidate.theme,
      status,
      currentReadiness: before.readiness,
      proposedReadiness: after.readiness,
      currentIntervention: before.intervention,
      proposedIntervention: after.intervention,
      change: after.change,
      investigationQuestion: after.investigation,
      reason: failure ?? null,
    });
  }

  const totals: Record<ShadowEntry["status"], number> = {
    added: 0,
    changed: 0,
    unchanged: 0,
    removed: 0,
    failed: 0,
    blocked: 0,
  };
  for (const entry of entries) totals[entry.status] += 1;
  const report: ShadowReport = {
    schemaVersion: "recommendation-shadow/1",
    generatedAt: new Date().toISOString(),
    domain: site.domain,
    projectId: opts.projectId,
    siteId: opts.siteId,
    model,
    totals,
    entries,
  };
  if (opts.outPath) writeFileSync(opts.outPath, JSON.stringify(report, null, 2));
  return report;
}
