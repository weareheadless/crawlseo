import { createHash } from "node:crypto";

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
  buildDependencyManifest,
  decisionFingerprint,
  hashPacket,
  hashValue,
  parsePersistedDecision,
  parsePersistedDependencyManifest,
  parsePersistedPacket,
  validateDecision,
  validateEvidenceRequest,
  type AssessmentAttempt,
  type DependencyManifest,
  type EvidencePacket,
  type RecommendationDecision,
} from "@/lib/recommendation/contracts";
import { RECOMMENDATION_PROMPT_VERSION, assessRecommendation } from "@/lib/recommendation/assess";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import {
  buildEvidencePacket,
  expandEvidencePacket,
  inventoryRowsForPacket,
  type PacketDb,
} from "@/lib/recommendation/packet";
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
  attempts?: AssessmentAttempt[];
  ledger?: ReturnType<AnalysisLedger["snapshot"]>;
};

async function recordAnalysisFailure(
  db: AssessmentRunDb,
  input: {
    projectId: string;
    siteId: string;
    findingId: string;
    packet: EvidencePacket;
    initialPacketHash: string;
    errors: string[];
    ledger: unknown;
    raw: unknown;
    attempts: AssessmentAttempt[];
    requests: EvidencePacket["requests"];
    trace: string[];
    dependencies: DependencyManifest;
  }
): Promise<{ ok: boolean; error?: string }> {
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
          packetHash: input.packet.packetHash,
          initialPacketHash: input.initialPacketHash,
          packetJson: JSON.stringify(input.packet),
          dependenciesJson: JSON.stringify(input.dependencies),
          errors: input.errors,
          ledger: input.ledger,
          raw: input.raw,
          attempts: input.attempts,
          requests: input.requests,
          trace: input.trace,
        } as never,
      },
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    console.error("[recommendation] failed to record analysis failure", error);
    return { ok: false, error: `analysis failure archive could not be written: ${message}` };
  }
}

function currentModel(): string | null {
  return contentWriterConfig()?.model ?? null;
}

type ReuseDb = Pick<
  PrismaClient,
  "auditPage" | "crawl" | "researchSource" | "businessKnowledgeDocument" | "businessKnowledgeRevision" | "evidenceRecord"
>;

/**
 * Check the archived dependency manifest against current versioned storage.
 *
 * Stored pages must still have the exact content hash the decision used. Sources
 * must still have the same excerpt and observation time. Business knowledge must
 * still be the same revision. Live pages cannot be version-checked without a new
 * fetch; they are reusable only inside the freshness window and only when the
 * archived retrieval was not truncated.
 */
async function dependenciesStillMatch(
  db: ReuseDb,
  manifest: DependencyManifest,
  packet: EvidencePacket
): Promise<boolean> {
  const urls = manifest.pages.map((page) => page.url);
  const crawl = await db.crawl.findFirst({
    where: { siteId: packet.siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  const storedPages = urls.length && crawl
    ? await db.auditPage.findMany({
        where: { crawlId: crawl.id, url: { in: urls } },
        select: { url: true, contentHash: true, contentText: true },
      })
    : [];
  const pageByUrl = new Map(storedPages.map((row) => [row.url, row]));
  for (const page of manifest.pages) {
    if (page.retrieval === "stored") {
      const row = pageByUrl.get(page.url);
      if (!row) return false;
      const currentHash =
        row.contentHash ??
        (row.contentText ? createHash("sha256").update(row.contentText).digest("hex") : null);
      if (currentHash !== page.contentHash) return false;
    } else if (page.retrieval === "live" || page.retrieval === "rendered") {
      // Incomplete live or rendered retrieval cannot support a reused whole-page decision.
      if (page.truncated) return false;
    } else {
      return false;
    }
  }

  const sourceIds = manifest.sources.map((source) => source.id.replace(/^source:/, ""));
  const storedSources = sourceIds.length
    ? await db.researchSource.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true, excerpt: true, retrievedAt: true },
      })
    : [];
  const sourceById = new Map(storedSources.map((row) => [`source:${row.id}`, row]));
  for (const source of manifest.sources) {
    const row = sourceById.get(source.id);
    if (!row) return false;
    const currentHash = row.excerpt ? hashValue(row.excerpt) : null;
    if (currentHash !== source.excerptHash) return false;
    if (row.retrievedAt.toISOString() !== source.observedAt) return false;
  }

  const document = await db.businessKnowledgeDocument.findUnique({
    where: { projectId: packet.projectId },
    select: { id: true, revision: true, acceptedRevision: true },
  });
  const revisionNumber = document ? (document.acceptedRevision ?? document.revision) : null;
  if ((revisionNumber ?? null) !== (manifest.businessKnowledge.documentRevision ?? null)) return false;

  const searchIds = manifest.searchIds.map((id) => id.replace(/^search:/, ""));
  if (searchIds.length > 0) {
    const found = await db.evidenceRecord.findMany({
      where: { id: { in: searchIds } },
      select: { id: true },
    });
    if (found.length !== searchIds.length) return false;
  }
  return true;
}

export async function findReusableDecision(
  db: ReuseDb,
  dimensions: Record<string, unknown> | null,
  initialPacket: EvidencePacket,
  model: string | null,
  opts: { now?: Date } = {}
): Promise<{ decision: RecommendationDecision; packet: EvidencePacket } | null> {
  const decision = parsePersistedDecision(dimensions?.recommendationDecisionJson);
  if (!decision) return null;
  if (decision.promptVersion !== RECOMMENDATION_PROMPT_VERSION) return null;
  if (decision.policyVersion !== RECOMMENDATION_POLICY_VERSION) return null;
  if (model && decision.model !== model) return null;

  const now = opts.now ?? new Date();
  const assessedAt = Date.parse(decision.assessedAt);
  if (!Number.isFinite(assessedAt)) return null;
  const ageMs = now.getTime() - assessedAt;
  if (ageMs < 0 || ageMs > ANALYSIS_RESOURCE_POLICY.reuseMaxAgeDays * 24 * 60 * 60_000) return null;

  // The exact initial selection is mandatory. Without it an archive cannot be
  // bound to the current project, site or candidate.
  const initialHash = dimensions?.recommendationInitialPacketHash;
  if (typeof initialHash !== "string" || initialHash !== initialPacket.packetHash) return null;
  if (hashPacket(initialPacket) !== initialPacket.packetHash) return null;

  const finalPacket = parsePersistedPacket(dimensions?.recommendationFinalPacketJson);
  if (!finalPacket) return null;

  // Archived content must still match its own hash. A mutable JSON blob is not
  // evidence until that is verified.
  if (hashPacket(finalPacket) !== finalPacket.packetHash) return null;
  if (decision.packetHash !== finalPacket.packetHash) return null;

  if (
    finalPacket.projectId !== initialPacket.projectId ||
    finalPacket.siteId !== initialPacket.siteId ||
    finalPacket.candidate.findingId !== initialPacket.candidate.findingId ||
    finalPacket.candidate.dedupKey !== initialPacket.candidate.dedupKey
  ) {
    return null;
  }

  if (!validateDecision(decision, finalPacket).ok) return null;

  const storedManifest = parsePersistedDependencyManifest(dimensions?.recommendationDependenciesJson);
  if (!storedManifest) return null;
  if (storedManifest.finalPacketHash !== finalPacket.packetHash) return null;
  const computedManifest = buildDependencyManifest(finalPacket);
  if (hashValue(computedManifest) !== hashValue(storedManifest)) return null;
  if (!(await dependenciesStillMatch(db, storedManifest, finalPacket))) return null;

  return { decision, packet: finalPacket };
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
    remainingBytes: () => ledger.remainingBytes(),
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
    const reusable = await findReusableDecision(
      db,
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
        decision: reusable.decision,
        packet: reusable.packet,
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
  const attempts: AssessmentAttempt[] = [];
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
    if (outcome.history && outcome.history.length > 0) {
      attempts.push(...outcome.history);
    } else {
      // A custom assessor may not supply history. Keep the raw artifact and its
      // packet identity rather than silently losing the attempt.
      const rawArtifact = outcome.raw ?? outcome.rawAttempts?.[outcome.rawAttempts.length - 1] ?? null;
      attempts.push({
        round,
        attempt: 1,
        inputPacketHash: packet.packetHash,
        feedback: feedback || null,
        kind: outcome.kind === "final" ? "final_decision" : outcome.kind === "request" ? "request_evidence" : "validation_error",
        raw: rawArtifact,
        responseText: null,
        errors: outcome.kind === "failure" ? outcome.errors : [],
      });
    }

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
      inventoryRows: inventoryRowsForPacket(packet),
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
      remainingBytes: () => ledger.remainingBytes(),
      deadlineAt: ledger.deadlineAt(),
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
        attempts,
        ledger: ledger.snapshot(),
      };
    }
    const dependencies = buildDependencyManifest(packet);
    // A model failure is not a rejection of the customer need. Preserve the
    // previous valid decision and record the failed attempt separately.
    if (previous) {
      const archived = await recordAnalysisFailure(db, {
        projectId: input.projectId,
        siteId: input.siteId,
        findingId: input.finding.id,
        packet,
        initialPacketHash: initialPacket.packetHash,
        errors,
        ledger: ledger.snapshot(),
        raw,
        attempts,
        requests: requestOutcomes,
        trace,
        dependencies,
      });
      return {
        findingId: input.finding.id,
        status: "failed",
        decision: null,
        packet,
        evidenceId: previous.id,
        errors: archived.ok ? errors : [...errors, archived.error ?? "analysis failure archive could not be written"],
        raw,
        trace,
        attempts,
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
        recommendationAttemptsJson: JSON.stringify(attempts),
        recommendationRequestsJson: JSON.stringify(requestOutcomes),
        recommendationDependenciesJson: JSON.stringify(dependencies),
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
      attempts,
      ledger: ledger.snapshot(),
    };
  }

  const validation = validateDecision(decision, packet);
  if (!validation.ok) {
    // Defensive: the assessor validates before returning. Never publish an invalid
    // decision merely because a custom assessor skipped that check.
    let errors = validation.errors;
    if (input.persist !== false) {
      const archived = await recordAnalysisFailure(db, {
        projectId: input.projectId,
        siteId: input.siteId,
        findingId: input.finding.id,
        packet,
        initialPacketHash: initialPacket.packetHash,
        errors: validation.errors,
        ledger: ledger.snapshot(),
        raw,
        attempts,
        requests: requestOutcomes,
        trace,
        dependencies: buildDependencyManifest(packet),
      });
      if (!archived.ok) errors = [...errors, archived.error ?? "analysis failure archive could not be written"];
    }
    return {
      findingId: input.finding.id,
      status: "failed",
      decision: null,
      packet,
      evidenceId: previous?.id ?? null,
      errors,
      raw,
      trace,
      attempts,
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
      attempts,
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
    recommendationAttemptsJson: JSON.stringify(attempts),
    recommendationRequestsJson: JSON.stringify(requestOutcomes),
    recommendationDependenciesJson: JSON.stringify(buildDependencyManifest(packet)),
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
    attempts,
    ledger: ledger.snapshot(),
  };
}
