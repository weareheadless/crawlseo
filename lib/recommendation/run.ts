import type { PrismaClient } from "@prisma/client";

import {
  computeObservationHash,
  storeEvidenceRecord,
  supersedeEvidenceRecord,
  type EvidenceRecordPayload,
} from "@/lib/funnel/evidence";
import {
  decisionFingerprint,
  parsePersistedDecision,
  validateDecision,
  type EvidencePacket,
  type RecommendationDecision,
} from "@/lib/recommendation/contracts";
import { assessRecommendation } from "@/lib/recommendation/assess";
import { buildEvidencePacket, type PacketDb } from "@/lib/recommendation/packet";
import { publishDecision } from "@/lib/recommendation/publish";

/**
 * Assess one research finding and publish its decision through the existing spine.
 *
 * Reuse is keyed to the sealed packet, not to the finding's sentence. A changed
 * page, source, business fact, prompt or model therefore invalidates the old
 * assessment even when the wording did not change.
 */

export type AssessmentRunDb = PacketDb &
  Pick<PrismaClient, "opportunity" | "evidenceRecord" | "rawProviderResponse" | "evidenceEdge">;

export type FindingForAssessment = {
  id: string;
  runId: string;
  type: string;
  theme: string;
  summary: string;
  premise: string | null;
  observedAt: Date;
  sourceIds: string[];
  dedupKey: string;
  dimensions: Record<string, string | number | boolean | null>;
};

export type FindingAssessmentResult = {
  findingId: string;
  status: "assessed" | "reused" | "failed" | "no_decision";
  decision: RecommendationDecision | null;
  packet: EvidencePacket | null;
  evidenceId: string | null;
  errors: string[];
  raw?: unknown;
};

function existingDecision(
  dimensions: Record<string, unknown> | null,
  packet: EvidencePacket
): RecommendationDecision | null {
  const decision = parsePersistedDecision(dimensions?.recommendationDecisionJson);
  if (!decision) return null;
  if (decision.packetHash !== packet.packetHash) return null;
  if (decision.promptVersion !== (dimensions?.recommendationPromptVersion ?? decision.promptVersion)) return null;
  if (!validateDecision(decision, packet).ok) return null;
  return decision;
}

export async function assessFinding(
  db: AssessmentRunDb,
  input: {
    projectId: string;
    siteId: string;
    finding: FindingForAssessment;
    assessor?: typeof assessRecommendation;
    maxAttempts?: number;
    /** False for read-only evaluation: assess but do not write evidence or publish. */
    persist?: boolean;
    /** True to bypass reuse and call the assessor even when a packet hash matches. */
    force?: boolean;
    /** Read-only evaluation may supply facts extracted from live pages. */
    businessFacts?: EvidencePacket["businessFacts"];
  }
): Promise<FindingAssessmentResult> {
  const packet = await buildEvidencePacket(db, {
    projectId: input.projectId,
    siteId: input.siteId,
    businessFacts: input.businessFacts,
    candidate: {
      findingId: input.finding.id,
      dedupKey: input.finding.dedupKey,
      findingType: input.finding.type,
      theme: input.finding.theme,
      summary: input.finding.summary,
      premise: input.finding.premise,
      observedAt: input.finding.observedAt,
      sourceIds: input.finding.sourceIds,
    },
  });

  const active = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "research_finding", supersededById: null },
    select: { id: true, dimensions: true },
  });
  const previous = active.find((row) => (row.dimensions as { findingId?: unknown } | null)?.findingId === input.finding.id);

  const reusable = input.force ? null : existingDecision((previous?.dimensions ?? null) as Record<string, unknown> | null, packet);
  if (reusable) {
    return {
      findingId: input.finding.id,
      status: "reused",
      decision: reusable,
      packet,
      evidenceId: previous?.id ?? null,
      errors: [],
    };
  }

  const assessor = input.assessor ?? assessRecommendation;
  const result = await assessor(packet, { maxAttempts: input.maxAttempts });

  if (!result.ok) {
    if (input.persist === false) {
      return {
        findingId: input.finding.id,
        status: "failed",
        decision: null,
        packet,
        evidenceId: null,
        errors: result.errors,
        raw: result.raw,
      };
    }
    // A model failure is not a rejection of the customer need. Preserve a previous
    // valid decision; otherwise record the failed attempt as unassessed.
    if (previous) {
      return {
        findingId: input.finding.id,
        status: "failed",
        decision: null,
        packet,
        evidenceId: previous.id,
        errors: result.errors,
        raw: result.raw,
      };
    }
    const dimensions = {
      ...input.finding.dimensions,
      recommendationError: result.errors.join("; ").slice(0, 1_500) || "assessment failed",
      recommendationOutcome: "assessment_failed",
      recommendationDedupKey: input.finding.dedupKey,
      recommendationPacketHash: packet.packetHash,
    };
    const stored = await storeEvidenceRecord(db, {
      projectId: input.projectId,
      siteId: input.siteId,
      kind: "research_finding",
      observedAt: input.finding.observedAt,
      producer: "recommendation-producer",
      dimensions,
      metrics: {},
    });
    return {
      findingId: input.finding.id,
      status: "failed",
      decision: null,
      packet,
      evidenceId: stored.id,
      errors: result.errors,
      raw: result.raw,
    };
  }

  const decision = result.decision;
  if (input.persist === false) {
    return {
      findingId: input.finding.id,
      status: "assessed",
      decision,
      packet,
      evidenceId: null,
      errors: [],
    };
  }
  const fingerprint = decisionFingerprint({
    packetHash: decision.packetHash,
    policyVersion: decision.policyVersion,
    promptVersion: decision.promptVersion,
    model: decision.model,
  });
  const dimensions = {
    ...input.finding.dimensions,
    recommendationDecisionJson: JSON.stringify(decision),
    recommendationDedupKey: decision.dedupKey,
    recommendationPacketHash: decision.packetHash,
    recommendationFingerprint: fingerprint,
    recommendationVersion: decision.schemaVersion,
    recommendationPromptVersion: decision.promptVersion,
    recommendationModel: decision.model,
    recommendationOutcome: decision.readiness,
    recommendationError: null,
  };

  const payload: EvidenceRecordPayload = {
    projectId: input.projectId,
    siteId: input.siteId,
    kind: "research_finding",
    observedAt: input.finding.observedAt,
    producer: "recommendation-producer",
    dimensions,
    metrics: {},
  };
  const hash = computeObservationHash(payload);
  let evidenceId: string;
  if (previous) {
    const same = computeObservationHash({
      ...payload,
      dimensions: (previous.dimensions ?? {}) as never,
    });
    if (same === hash) {
      evidenceId = previous.id;
    } else {
      const stored = await supersedeEvidenceRecord(db, previous.id, payload);
      evidenceId = stored.id;
    }
  } else {
    const stored = await storeEvidenceRecord(db, payload);
    evidenceId = stored.id;
  }

  await publishDecision(db, {
    projectId: input.projectId,
    decision,
    findingType: input.finding.type,
    evidenceId,
  });

  return {
    findingId: input.finding.id,
    status: "assessed",
    decision,
    packet,
    evidenceId,
    errors: [],
  };
}
