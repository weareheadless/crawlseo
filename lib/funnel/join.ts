import type { PrismaClient } from "@prisma/client";

import { addEdge, type EdgeDb } from "@/lib/funnel/edges";
import { completenessLeg } from "@/lib/funnel/opportunity";
import { computeScore, freshnessFactor, type ScoreInputs } from "@/lib/funnel/scoring";
import { parseOpportunityProposal } from "@/lib/funnel/proposal";
import { parsePersistedDecision } from "@/lib/recommendation/contracts";

/**
 * Missing-leg join scheduler (docs/seo-funnel-spine-plan.md §2.3).
 *
 * Opportunities detected with one leg are valid but score lower. This module
 * (a) classifies what follow-up collection would join the missing leg and
 * (b) applies a join when the corresponding evidence arrives, recomputing the
 * score. Follow-ups are computed, never guessed; the re-score uses only
 * stored evidence.
 */

export type JoinDb = EdgeDb & Pick<PrismaClient, "opportunity" | "evidenceRecord">;

export type FollowUpRequest = {
  opportunityId: string;
  missingLeg: "why" | "how";
  /** declared collection that would join the leg */
  collection: string;
};

const FOLLOW_UP_COLLECTION: Record<string, { why: string; how: string }> = {
  O1_winnable_rank: { why: "link keyword to business knowledge / offer relevance", how: "" },
  O2_striking_distance: { why: "link keyword to business knowledge / offer relevance", how: "" },
  O3_content_gap: { why: "research grounding from market research", how: "" },
  O4_aeo_citation_gap: { why: "", how: "" },
  O5_aeo_presence_gap: { why: "link question to business knowledge / offer relevance", how: "schedule AI visibility evaluation for the question" },
  O6_business_fact_mismatch: { why: "", how: "" },
  O7_technical_defect: { why: "", how: "" },
  O8_structured_data_gap: { why: "", how: "" },
  O9_backlink_gap: { why: "", how: "" },
  O10_cannibalization: { why: "", how: "" },
  O11_freshness_decay: { why: "", how: "" },
  O12_page_experience: { why: "", how: "" },
  O13_user_pain_point: { why: "", how: "keyword validation (volume/competition) for the pain-point query" },
  O14_offer_positioning_gap: { why: "", how: "SERP composition evidence for the positioning query" },
};

export async function computeFollowUps(db: JoinDb, projectId: string): Promise<FollowUpRequest[]> {
  const opportunities = await db.opportunity.findMany({
    where: { projectId, status: { in: ["detected", "accepted"] } },
    select: { id: true, type: true, evidenceCompleteness: true, scoreInputs: true, title: true, summary: true, dedupKey: true, dimension: true, detectedBy: true },
  });
  const requests: FollowUpRequest[] = [];
  for (const opportunity of opportunities) {
    if (opportunity.evidenceCompleteness === "both") continue;
    const missing = opportunity.evidenceCompleteness === "why" ? "how" : opportunity.evidenceCompleteness === "how" ? "why" : null;
    if (!missing) continue;
    const collection = FOLLOW_UP_COLLECTION[opportunity.type]?.[missing];
    // Every missing why leg can be joined from business knowledge, so it is a
    // follow-up even when the table has no label for it. A missing how leg needs a
    // declared collection, otherwise there is nothing to run.
    if (collection) requests.push({ opportunityId: opportunity.id, missingLeg: missing, collection });
    else if (missing === "why") requests.push({ opportunityId: opportunity.id, missingLeg: "why", collection: "link business knowledge / offer relevance" });
  }
  return requests;
}

export type EvidenceLike = {
  id: string;
  observedAt: Date;
  metrics: unknown;
  dimensions: unknown;
};

/**
 * Apply a join: attach newly-arrived evidence of the missing leg to the
 * opportunity and recompute the score from stored evidence. Only call this
 * when the evidence record genuinely addresses the opportunity (the caller
 * owns matching; this module owns the re-score and the edge write).
 */
/**
 * What a newly arrived observation changes about the assessment.
 *
 * Attaching an edge and raising completeness is not measurement: a keyword volume
 * that arrives must replace the demand inputs the score is computed from, or the
 * board shows "two legs" with no number behind it.
 */
export function assessmentOverridesFromEvidence(evidence: EvidenceLike): Partial<ScoreInputs["worth"]> {
  const metrics = (evidence.metrics ?? {}) as Record<string, { value?: number | null } | undefined>;
  const volume = metrics["provider:volume"]?.value;
  if (typeof volume === "number" && Number.isFinite(volume) && volume > 0) {
    return { volume, volumeSource: "provider" };
  }
  return {};
}

export async function applyJoin(
  db: JoinDb,
  opportunityId: string,
  evidence: EvidenceLike,
  leg: "why" | "how",
  scoreInputs: Omit<ScoreInputs, "evidenceCompleteness">,
  opts: { joinedBy: string; now?: Date } = { joinedBy: "funnel-join" }
): Promise<{ scoreValue: number; evidenceCompleteness: string }> {
  const opportunity = await db.opportunity.findUnique({ where: { id: opportunityId } });
  if (!opportunity) throw new Error("opportunity not found");
  await addEdge(db, {
    fromType: "evidence_record",
    fromId: evidence.id,
    toType: "opportunity",
    toId: opportunity.id,
    relation: "supporting",
    createdBy: opts.joinedBy,
  });
  const legCounts = await db.evidenceEdge.count({
    where: { toType: "opportunity", toId: opportunityId, relation: "supporting" },
  });
  void legCounts;
  const whyCount = leg === "why" ? 1 : 0;
  const howCount = leg === "how" ? 1 : 0;
  // The re-score recomputes completeness from the leg of the record we just
  // joined onto the leg recorded on the opportunity.
  const joinedLeg = completenessLeg(
    opportunity.evidenceCompleteness === "why" ? 1 : opportunity.evidenceCompleteness === "both" ? 1 : whyCount,
    opportunity.evidenceCompleteness === "how" ? 1 : opportunity.evidenceCompleteness === "both" ? 1 : howCount
  );
  const overrides = assessmentOverridesFromEvidence(evidence);
  const { scoreValue, inputs } = computeScore({
    ...(scoreInputs as Omit<ScoreInputs, "evidenceCompleteness">),
    worth: { ...(scoreInputs as Omit<ScoreInputs, "evidenceCompleteness">).worth, ...overrides },
    evidenceCompleteness: joinedLeg,
    freshness: Math.max(scoreInputs.freshness, freshnessFactor(evidence.observedAt, opts.now ?? new Date())),
  });
  const updated = await db.opportunity.update({
    where: { id: opportunityId },
    data: {
      scoreValue,
      scoreInputs: inputs as never,
      evidenceCompleteness: joinedLeg,
      lastScoredAt: opts.now ?? new Date(),
    },
    select: { scoreValue: true, evidenceCompleteness: true },
  });
  return { scoreValue: updated.scoreValue ?? scoreValue, evidenceCompleteness: updated.evidenceCompleteness };
}

/**
 * The task gate (plan §3, Wave 2): a task can only exist by accepting an
 * opportunity, at exactly one place. Agent output never creates tasks.
 */
export type TaskDb = Pick<PrismaClient, "task" | "opportunity"> & {
  $transaction?: PrismaClient["$transaction"];
};

const MIGRATED_TYPES = new Set(["O13_user_pain_point", "O14_offer_positioning_gap"]);

/**
 * The brief a person receives when they accept a recommendation.
 *
 * Accepting used to create a task with the opportunity's title and nothing else, so
 * the person had to reconstruct the reason, the target page and the check. The
 * decision already holds those; this turns them into the task plan.
 */
export function taskPlanFromOpportunity(opportunity: {
  title: string;
  summary: string;
  scoreInputs: unknown;
  recommendationDecision?: unknown;
}): Record<string, unknown> {
  const proposal = parseOpportunityProposal(opportunity.recommendationDecision);
  if (proposal) {
    return {
      kind: proposal.kind === "business" ? "investigation" : "implementation",
      lane: proposal.lane,
      proposalKind: proposal.kind,
      readiness: proposal.readiness,
      whyNow: proposal.whyNow,
      target: proposal.target,
      action: proposal.action,
      expectedOutcome: proposal.expectedOutcome,
      effort: proposal.effort,
      confidence: proposal.confidence,
      expiresAt: proposal.expiresAt,
      sources: proposal.sources,
      critique: proposal.critique,
      change: proposal.action,
      targetPages: proposal.target.url ? [proposal.target.url] : [],
      successMeasure: proposal.expectedOutcome,
      need: opportunity.summary,
    };
  }
  const decision = parsePersistedDecision(opportunity.recommendationDecision);
  if (decision) {
    return {
      kind: decision.readiness === "needs_investigation" ? "investigation" : "implementation",
      decisionVersion: decision.schemaVersion,
      decisionId: decision.decisionId,
      packetHash: decision.packetHash,
      readiness: decision.readiness,
      intervention: decision.intervention,
      question: decision.question.text,
      premise: decision.premise,
      needRationale: decision.question.rationale,
      needBases: decision.question.bases,
      offerFitRationale: decision.offerFit.rationale,
      coverage: decision.coverage,
      change: decision.change,
      assetJustification: decision.assetJustification,
      investigation: decision.investigation,
      targets: decision.targets,
      benefits: decision.benefits,
      effort: decision.effort,
      risks: decision.risks,
      reviews: decision.reviews,
      success: decision.success,
      uncertainty: decision.uncertainty,
      contradictions: decision.contradictions,
    };
  }
  const worth = (opportunity.scoreInputs as { worth?: Record<string, unknown> } | null)?.worth ?? {};
  const read = (key: string) => (typeof worth[key] === "string" ? (worth[key] as string) : null);
  const targetPages = Array.isArray(worth.targetPages)
    ? (worth.targetPages as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const list = (key: string) =>
    Array.isArray(worth[key]) ? (worth[key] as unknown[]).filter((value): value is string => typeof value === "string") : [];
  return {
    kind: "legacy",
    readiness: read("readiness"),
    intervention: read("intervention"),
    benefitTrack: read("benefitTrack"),
    measurement: read("measurement"),
    need: opportunity.summary,
    needRationale: read("needRationale"),
    needEvidenceUrls: list("needEvidenceUrls"),
    offerFitRationale: read("offerFitRationale"),
    offerFitEvidenceUrls: list("offerFitEvidenceUrls"),
    assessmentModel: read("assessmentModel"),
    existingCoverage: read("coverageSummary"),
    change: read("change"),
    targetPages,
    successMeasure: read("successMeasure"),
    uncertainty: list("uncertainty"),
  };
}

/**
 * Accept one opportunity into human work.
 *
 * The authoritative decision is loaded from the opportunity, not trusted from the
 * caller. A migrated recommendation must be a valid actionable decision or a
 * genuine bounded investigation; legacy-unassessed rows cannot become
 * implementation work. The task and the opportunity transition are written
 * together, with a version precondition that refuses a stale page.
 */
export async function acceptOpportunityIntoTask(
  db: TaskDb,
  opportunityId: string,
  input: {
    title: string;
    assignedTo: string;
    plan?: unknown;
    agentPreparedById?: string;
    recommendationDecision?: unknown;
    /** The decision version rendered to the person who clicked accept. */
    expectedDecisionId?: string | null;
    /** The project that owns the site the person is acting in. */
    expectedProjectId?: string | null;
  }
): Promise<string> {
  const opportunity = await db.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      id: true,
      projectId: true,
      status: true,
      type: true,
      title: true,
      summary: true,
      scoreInputs: true,
      recommendationDecision: true,
      recommendationFingerprint: true,
    },
  });
  if (!opportunity) throw new Error("opportunity not found");
  if (!["detected", "parked", "in_progress"].includes(opportunity.status)) {
    throw new Error(`opportunity status "${opportunity.status}" cannot be accepted into a task`);
  }
  if (!input.assignedTo || input.assignedTo.trim() === "") {
    throw new Error("a task requires a human executor (plan decision 3)");
  }

  const decision = parsePersistedDecision(opportunity.recommendationDecision);
  const phase3 = parseOpportunityProposal(opportunity.recommendationDecision);
  if (phase3) {
    if (input.expectedProjectId && opportunity.projectId !== input.expectedProjectId) {
      throw new Error("this opportunity does not belong to the site's project");
    }
    if (!input.expectedProjectId) {
      throw new Error("accepting a proposal requires its project scope");
    }
    if (phase3.readiness !== "actionable" && phase3.readiness !== "needs_investigation") {
      throw new Error(`opportunity readiness "${phase3.readiness}" cannot be accepted into work`);
    }
  } else if (MIGRATED_TYPES.has(opportunity.type)) {
    if (!decision) {
      throw new Error("this recommendation has not been assessed under the current contract and cannot become work");
    }
    if (input.expectedProjectId && opportunity.projectId !== input.expectedProjectId) {
      throw new Error("this opportunity does not belong to the site's project");
    }
    if (!input.expectedProjectId) {
      throw new Error("accepting a recommendation requires its project scope");
    }
    if (!input.expectedDecisionId) {
      throw new Error("accepting a recommendation requires the decision version shown to the user");
    }
    if (input.expectedDecisionId !== decision.decisionId) {
      throw new Error("the recommendation changed since this page was loaded; review the current decision before accepting");
    }
    if (decision.readiness !== "actionable" && decision.readiness !== "needs_investigation") {
      throw new Error(`opportunity readiness "${decision.readiness}" cannot be accepted into work`);
    }
    if (input.recommendationDecision != null) {
      const supplied = parsePersistedDecision(input.recommendationDecision);
      if (!supplied || supplied.decisionId !== decision.decisionId) {
        throw new Error("the recommendation changed since this page was loaded; review the current decision before accepting");
      }
    }
  } else if (input.recommendationDecision != null) {
    const raw = input.recommendationDecision as { readiness?: unknown } | null;
    if (raw && typeof raw.readiness === "string" && raw.readiness !== "actionable") {
      throw new Error(`opportunity readiness "${raw.readiness}" cannot be accepted into implementation work`);
    }
    const supplied = parsePersistedDecision(input.recommendationDecision);
    if (!supplied) throw new Error("the recommendation decision is malformed and cannot be accepted");
    if (supplied.readiness !== "actionable") {
      throw new Error(`opportunity readiness "${supplied.readiness}" cannot be accepted into implementation work`);
    }
    if (input.expectedDecisionId && supplied.decisionId !== input.expectedDecisionId) {
      throw new Error("the recommendation changed since this page was loaded; review the current decision before accepting");
    }
  }

  const plan = decision || phase3
    ? taskPlanFromOpportunity(opportunity)
    : ((input.plan ?? undefined) as Record<string, unknown> | undefined);
  const expectedFingerprint = opportunity.recommendationFingerprint ?? null;

  const write = async (tx: Pick<PrismaClient, "task" | "opportunity">) => {
    const where = { id: opportunityId, status: opportunity.status, recommendationFingerprint: expectedFingerprint };
    const updated = await tx.opportunity.updateMany({
      where,
      data: { status: "accepted", decidedBy: input.assignedTo, decidedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new Error("the recommendation changed while it was being accepted; reload and review it");
    }
    return tx.task.create({
      data: {
        opportunityId,
        title: input.title,
        assignedTo: input.assignedTo,
        status: "todo",
        plan: (plan ?? undefined) as never,
        agentPreparedById: input.agentPreparedById ?? null,
      },
      select: { id: true },
    });
  };

  if (!db.$transaction) {
    throw new Error("accepting a recommendation requires a transaction-capable database client");
  }
  const task = await db.$transaction((tx) => write(tx));
  return task.id;
}

/**
 * The opportunity follows its task's lifecycle.
 *
 * An opportunity whose work shipped is no longer a to-do: it leaves the open
 * list and stays visible as delivered work. Verifying the outcome closes it.
 * Rows in any other state (parked, rejected) are left alone.
 */
export async function syncOpportunityStatus(
  db: TaskDb,
  taskId: string,
  taskStatus: string,
): Promise<void> {
  const task = await db.task.findUnique({ where: { id: taskId }, select: { opportunityId: true } });
  if (!task?.opportunityId) return;
  const move: Record<string, { next: "in_progress" | "delivered" | "closed"; from: Array<"accepted" | "in_progress" | "delivered"> }> = {
    in_progress: { next: "in_progress", from: ["accepted"] },
    delivered: { next: "delivered", from: ["accepted", "in_progress"] },
    verified_outcome: { next: "closed", from: ["accepted", "in_progress", "delivered"] },
  };
  const target = move[taskStatus];
  if (!target) return;
  await db.opportunity.updateMany({
    where: { id: task.opportunityId, status: { in: target.from } },
    data: { status: target.next },
  });
}

export async function confirmHumanStep(
  db: TaskDb,
  taskId: string,
  input: { status: "in_progress" | "awaiting_human" | "delivered" | "verified_outcome"; confirmedBy: string }
): Promise<void> {
  if (!input.confirmedBy || input.confirmedBy.trim() === "") {
    throw new Error("human confirmation requires a name (distinct from agent-prepared artifacts)");
  }
  await db.task.update({
    where: { id: taskId },
    data: {
      status: input.status,
      humanConfirmedBy: input.confirmedBy,
      humanConfirmedAt: new Date(),
    },
  });
  await syncOpportunityStatus(db, taskId, input.status);
}

/**
 * Agent-prepared artifacts land the task in `awaiting_human` (plan decision 3):
 * detection, research and drafting can be agent-driven, but execution and
 * publication stay human-confirmed. The agent identity is recorded on the
 * artifact, distinct from the human confirmation fields.
 */
export async function recordAgentPreparation(
  db: TaskDb,
  taskId: string,
  input: { agentId: string; plan: unknown }
): Promise<void> {
  if (!input.agentId || input.agentId.trim() === "") {
    throw new Error("agent-prepared artifacts require an agent identity");
  }
  const task = await db.task.findUnique({ where: { id: taskId }, select: { status: true } });
  if (!task) throw new Error("task not found");
  if (task.status === "delivered" || task.status === "verified_outcome") {
    throw new Error(`cannot attach agent preparation to a ${task.status} task`);
  }
  await db.task.update({
    where: { id: taskId },
    data: {
      status: "awaiting_human",
      agentPreparedById: input.agentId,
      plan: input.plan as never,
    },
  });
}

export async function recordDeliveryOutcome(
  db: Pick<PrismaClient, "outcomeObservation" | "task">,
  input: {
    taskId: string;
    baseline: { metrics: Record<string, { value: number; unit: string }>; observedAt: Date };
    after: { metrics: Record<string, { value: number; unit: string }>; observedAt: Date };
    verdict: "verified_win" | "no_effect" | "regression" | "unmeasured" | "pending";
    measuredBy: string;
  }
): Promise<string> {
  if (input.verdict !== "unmeasured" && input.verdict !== "pending") {
    if (!input.baseline?.observedAt || input.baseline.observedAt.getTime() >= input.after.observedAt.getTime()) {
      throw new Error("an outcome requires a pre-delivery baseline (invariant 9: no baseline ⇒ unmeasured)");
    }
  }
  const observation = await db.outcomeObservation.create({
    data: {
      taskId: input.taskId,
      baselineMetrics: input.baseline.metrics as never,
      baselineObservedAt: input.baseline.observedAt,
      afterMetrics: input.after.metrics as never,
      afterObservedAt: input.after.observedAt,
      verdict: input.verdict,
      measuredBy: input.measuredBy,
    },
    select: { id: true },
  });
  if (input.verdict !== "pending") {
    await db.task.update({
      where: { id: input.taskId },
      data: { status: input.verdict === "verified_win" ? "verified_outcome" : "delivered" },
    });
  }
  return observation.id;
}
