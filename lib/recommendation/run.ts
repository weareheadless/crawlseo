import type { PrismaClient } from "@prisma/client";

import {
  computeObservationHash,
  storeEvidenceRecord,
  supersedeEvidenceRecord,
  type EvidenceRecordPayload,
} from "@/lib/funnel/evidence";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import {
  RECOMMENDATION_POLICY_VERSION,
  decisionFingerprint,
  parsePersistedDecision,
  validateDecision,
  validateEvidenceRequest,
  type EvidencePacket,
  type RecommendationDecision,
} from "@/lib/recommendation/contracts";
import { RECOMMENDATION_PROMPT_VERSION, assessRecommendation } from "@/lib/recommendation/assess";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { buildEvidencePacket, expandEvidencePacket, type PacketDb } from "@/lib/recommendation/packet";
import { publishDecision } from "@/lib/recommendation/publish";

/**
 * Assess one research finding and publish its decision through the existing spine.
 *
 * The assessment is a bounded loop: build the packet, let the AI decide or request
 * material evidence, resolve that request through scoped retrieval, and repeat
 * until a final decision or the resource policy stops it. Reuse is keyed to the
 * sealed packet and the current model/prompt/policy versions, not to the finding's
 * sentence.
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
  trace?: string[];
  ledger?: ReturnType<AnalysisLedger["snapshot"]>;
};

function currentModel(): string | null {
  return contentWriterConfig()?.model ?? null;
}

export function findReusableDecision(
  dimensions: Record<string, unknown> | null,
  packet: EvidencePacket,
  model: string | null
): RecommendationDecision | null {
  const decision = parsePersistedDecision(dimensions?.recommendationDecisionJson);
  if (!decision) return null;
  if (decision.packetHash !== packet.packetHash) return null;
  if (decision.promptVersion !== RECOMMENDATION_PROMPT_VERSION) return null;
  if (decision.policyVersion !== RECOMMENDATION_POLICY_VERSION) return null;
  if (model && decision.model !== model) return null;
  if (!validateDecision(decision, packet).ok) return null;
  return decision;
}

function clippedRaw(raw: unknown): string | null {
  if (raw == null) return null;
  try {
    const text = JSON.stringify(raw);
    return text.length > 60_000 ? text.slice(0, 60_000) : text;
  } catch {
    return null;
  }
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
    /** Shared across candidates so one run has one budget. */
    ledger?: AnalysisLedger;
  }
): Promise<FindingAssessmentResult> {
  const ledger = input.ledger ?? new AnalysisLedger();
  const site = await db.site.findUnique({ where: { id: input.siteId }, select: { domain: true } });
  const siteDomain = site?.domain ?? "";

  let packet = await buildEvidencePacket(db, {
    projectId: input.projectId,
    siteId: input.siteId,
    businessFacts: input.businessFacts,
    // Initial selection gets a small share of retrieval; requested evidence must
    // still have budget left.
    maxLiveFetches: Math.min(2, ledger.remainingLiveFetches()),
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

  if (!input.force) {
    const reusable = findReusableDecision(
      (previous?.dimensions ?? null) as Record<string, unknown> | null,
      packet,
      // An injected assessor is a test/fixture producer; comparing its model name
      // with the configured live model would invalidate a valid fixture decision.
      input.assessor ? null : currentModel()
    );
    if (reusable) {
      return {
        findingId: input.finding.id,
        status: "reused",
        decision: reusable,
        packet,
        evidenceId: previous?.id ?? null,
        errors: [],
        ledger: ledger.snapshot(),
      };
    }
  }

  const assessor = input.assessor ?? assessRecommendation;
  const trace: string[] = [];
  let decision: RecommendationDecision | null = null;
  let failure: string[] = [];
  let raw: unknown = null;
  let feedback = "";
  let round = 0;

  while (round <= ledger.policy.maxEvidenceRounds) {
    if (!ledger.canCallModel()) {
      failure = ["analysis model-call budget exhausted before a final decision"];
      break;
    }
    const outcome = await assessor(packet, {
      maxAttempts: input.maxAttempts,
      ledger,
      round,
      feedback: feedback || undefined,
    });
    raw = outcome.raw;

    if (outcome.kind === "final") {
      decision = outcome.decision;
      break;
    }
    if (outcome.kind === "failure") {
      failure = outcome.errors;
      break;
    }

    const requestValidation = validateEvidenceRequest(outcome.request, packet, {
      siteDomain,
      maxRequests: ledger.policy.maxRequestsPerRound,
    });
    if (!requestValidation.ok) {
      // The model asked for something the service cannot resolve. Treat it as an
      // invalid answer and request one corrected decision, rather than inventing
      // an investigation or silently ignoring the request.
      if (!ledger.canRepair()) {
        failure = requestValidation.errors;
        break;
      }
      ledger.chargeRepair();
      feedback = `Your evidence request cannot be resolved. Correct it and return a complete JSON object:\n- ${requestValidation.errors.join("\n- ")}`;
      continue;
    }
    if (!ledger.canRequestRound() || !ledger.canRetrieve(requestValidation.resolved.length)) {
      failure = ["analysis evidence budget exhausted before the requested evidence could be retrieved"];
      break;
    }

    ledger.startEvidenceRound(round + 1, outcome.request.rationale);
    ledger.chargeRetrieval(requestValidation.resolved.length);
    trace.push(
      ...outcome.request.requests.map((entry) => `${entry.type} ${entry.target}: ${entry.question}`)
    );
    const expanded = await expandEvidencePacket(db, packet, requestValidation.resolved, {
      siteDomain,
      maxLiveFetches: ledger.remainingLiveFetches(),
      round: round + 1,
    });
    ledger.chargeLiveFetches(expanded.retrieved);
    ledger.record({
      round: round + 1,
      action: "retrieval",
      detail: expanded.actions.join("; ").slice(0, 600) || "no request resolved",
      at: new Date().toISOString(),
    });
    packet = expanded.packet;
    round += 1;
    feedback = "";
  }

  if (!decision) {
    const errors = failure.length > 0 ? failure : ["the analysis did not return a final decision"];
    if (input.persist === false) {
      return {
        findingId: input.finding.id,
        status: "failed",
        decision: null,
        packet,
        evidenceId: null,
        errors,
        raw,
        trace,
        ledger: ledger.snapshot(),
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
        errors,
        raw,
        trace,
        ledger: ledger.snapshot(),
      };
    }
    const stored = await storeEvidenceRecord(db, {
      projectId: input.projectId,
      siteId: input.siteId,
      kind: "research_finding",
      observedAt: input.finding.observedAt,
      producer: "recommendation-producer",
      dimensions: {
        ...input.finding.dimensions,
        recommendationError: errors.join("; ").slice(0, 1_500),
        recommendationOutcome: "assessment_failed",
        recommendationDedupKey: input.finding.dedupKey,
        recommendationPacketHash: packet.packetHash,
        recommendationPacketJson: JSON.stringify(packet).slice(0, 200_000),
        recommendationAnalysisJson: JSON.stringify(ledger.snapshot()),
      },
      metrics: {},
    });
    return {
      findingId: input.finding.id,
      status: "failed",
      decision: null,
      packet,
      evidenceId: stored.id,
      errors,
      raw,
      trace,
      ledger: ledger.snapshot(),
    };
  }

  const validation = validateDecision(decision, packet);
  if (!validation.ok) {
    // Defensive: the assessor validates before returning. Never publish an invalid
    // decision merely because a custom assessor skipped that check.
    return {
      findingId: input.finding.id,
      status: "failed",
      decision: null,
      packet,
      evidenceId: previous?.id ?? null,
      errors: validation.errors,
      raw,
      trace,
      ledger: ledger.snapshot(),
    };
  }

  if (input.persist === false) {
    return {
      findingId: input.finding.id,
      status: "assessed",
      decision,
      packet,
      evidenceId: null,
      errors: [],
      raw,
      trace,
      ledger: ledger.snapshot(),
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
    recommendationPacketJson: JSON.stringify(packet).slice(0, 200_000),
    recommendationAnalysisJson: JSON.stringify(ledger.snapshot()),
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
    previousEvidenceId: previous?.id ?? null,
  });

  return {
    findingId: input.finding.id,
    status: "assessed",
    decision,
    packet,
    evidenceId,
    errors: [],
    raw,
    trace,
    ledger: ledger.snapshot(),
  };
}
