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
  ANALYSIS_RESOURCE_POLICY,
  decisionFingerprint,
  parsePersistedDecision,
  parsePersistedPacket,
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

async function recordAnalysisFailure(
  db: AssessmentRunDb,
  input: { projectId: string; siteId: string; findingId: string; packetHash: string; errors: string[]; ledger: unknown; raw: unknown }
): Promise<void> {
  try {
    await db.rawProviderResponse.create({
      data: {
        provider: "recommendation-analysis",
        product: "assessment",
        endpoint: "internal",
        requestedAt: new Date(),
        deliveredAt: new Date(),
        status: "failed",
        payload: {
          projectId: input.projectId,
          siteId: input.siteId,
          findingId: input.findingId,
          packetHash: input.packetHash,
          errors: input.errors,
          ledger: input.ledger,
          raw: input.raw,
        } as never,
      },
    });
  } catch (error) {
    console.error("[recommendation] failed to record analysis failure", error);
  }
}

function currentModel(): string | null {
  return contentWriterConfig()?.model ?? null;
}

export function findReusableDecision(
  dimensions: Record<string, unknown> | null,
  initialPacket: EvidencePacket,
  model: string | null
): RecommendationDecision | null {
  const decision = parsePersistedDecision(dimensions?.recommendationDecisionJson);
  if (!decision) return null;
  if (decision.promptVersion !== RECOMMENDATION_PROMPT_VERSION) return null;
  if (decision.policyVersion !== RECOMMENDATION_POLICY_VERSION) return null;
  if (model && decision.model !== model) return null;

  const assessedAt = Date.parse(decision.assessedAt);
  if (!Number.isFinite(assessedAt)) return null;
  const ageMs = Date.now() - assessedAt;
  if (ageMs < 0 || ageMs > ANALYSIS_RESOURCE_POLICY.reuseMaxAgeDays * 24 * 60 * 60_000) return null;

  // The exact packet the decision used is archived with it. Revalidate against
  // that packet, not against a freshly rebuilt initial selection.
  const finalPacket =
    parsePersistedPacket(dimensions?.recommendationFinalPacketJson) ??
    parsePersistedPacket(dimensions?.recommendationPacketJson);

  const initialHash = dimensions?.recommendationInitialPacketHash;
  if (typeof initialHash === "string" && initialHash !== initialPacket.packetHash) return null;

  if (finalPacket) {
    if (finalPacket.packetHash !== decision.packetHash) return null;
    return validateDecision(decision, finalPacket).ok ? decision : null;
  }

  // Legacy decisions without an archived final packet are reusable only when the
  // initial packet itself was the exact input.
  if (decision.packetHash !== initialPacket.packetHash) return null;
  return validateDecision(decision, initialPacket).ok ? decision : null;
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

  const initialPacket = await buildEvidencePacket(db, {
    projectId: input.projectId,
    siteId: input.siteId,
    businessFacts: input.businessFacts,
    // The initial selection is deterministic stored evidence only. Material live
    // content is requested explicitly, so replay can compare a stable identity.
    maxLiveFetches: 0,
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
  let packet = initialPacket;

  const active = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "research_finding", supersededById: null },
    select: { id: true, dimensions: true },
  });
  const previous = active.find((row) => (row.dimensions as { findingId?: unknown } | null)?.findingId === input.finding.id);

  if (!input.force) {
    const reusable = findReusableDecision(
      (previous?.dimensions ?? null) as Record<string, unknown> | null,
      initialPacket,
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
  let noProgressRounds = 0;
  const rawAttempts: unknown[] = [];
  const requestOutcomes: EvidencePacket["requests"] = [];

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
    if (outcome.rawAttempts && outcome.rawAttempts.length > 0) rawAttempts.push(...outcome.rawAttempts);
    else if (outcome.raw != null) rawAttempts.push(outcome.raw);

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
      beforeFetch: () => {
        if (!ledger.canFetch()) throw new Error("analysis fetch budget exhausted before dispatch");
        ledger.chargeFetchAttempt();
      },
      onBytes: (bytes) => ledger.chargeBytes(bytes),
    });
    ledger.record({
      round: round + 1,
      action: "retrieval",
      detail: expanded.actions.join("; ").slice(0, 600) || "no request resolved",
      at: new Date().toISOString(),
    });
    packet = expanded.packet;
    requestOutcomes.push(...expanded.packet.requests.slice(requestOutcomes.length));
    noProgressRounds = expanded.progress ? 0 : noProgressRounds + 1;
    if (noProgressRounds >= 2) {
      failure = ["two consecutive evidence requests produced no new evidence"];
      break;
    }
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
    // A model failure is not a rejection of the customer need. Preserve the
    // previous valid decision and record the failed attempt separately.
    if (previous) {
      await recordAnalysisFailure(db, {
        projectId: input.projectId,
        siteId: input.siteId,
        findingId: input.finding.id,
        packetHash: packet.packetHash,
        errors,
        ledger: ledger.snapshot(),
        raw,
      });
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
        recommendationPacketJson: JSON.stringify(packet),
        recommendationFinalPacketJson: JSON.stringify(packet),
        recommendationInitialPacketHash: initialPacket.packetHash,
        recommendationAttemptsJson: JSON.stringify(rawAttempts),
        recommendationRequestsJson: JSON.stringify(requestOutcomes),
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
    recommendationPacketJson: JSON.stringify(packet),
    recommendationFinalPacketJson: JSON.stringify(packet),
    recommendationInitialPacketHash: initialPacket.packetHash,
    recommendationAttemptsJson: JSON.stringify(rawAttempts),
    recommendationRequestsJson: JSON.stringify(requestOutcomes),
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
