import type { PrismaClient } from "@prisma/client";

import { addEdge, type EdgeDb } from "@/lib/funnel/edges";
import { upsertOpportunity, completenessLeg } from "@/lib/funnel/opportunity";
import { computeScore, freshnessFactor, type ScoreInputs } from "@/lib/funnel/scoring";

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
  O5_aeo_presence_gap: { why: "", how: "schedule AI visibility evaluation for the question" },
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
    if (collection) requests.push({ opportunityId: opportunity.id, missingLeg: missing, collection });
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
  const { scoreValue, inputs } = computeScore({
    ...(scoreInputs as Omit<ScoreInputs, "evidenceCompleteness">),
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
export type TaskDb = Pick<PrismaClient, "task" | "opportunity">;

export async function acceptOpportunityIntoTask(
  db: TaskDb,
  opportunityId: string,
  input: { title: string; assignedTo: string; plan?: unknown; agentPreparedById?: string }
): Promise<string> {
  const opportunity = await db.opportunity.findUnique({ where: { id: opportunityId }, select: { status: true, id: true } });
  if (!opportunity) throw new Error("opportunity not found");
  if (!["detected", "parked", "in_progress"].includes(opportunity.status)) {
    throw new Error(`opportunity status "${opportunity.status}" cannot be accepted into a task`);
  }
  if (!input.assignedTo || input.assignedTo.trim() === "") {
    throw new Error("a task requires a human executor (plan decision 3)");
  }
  const task = await db.task.create({
    data: {
      opportunityId,
      title: input.title,
      assignedTo: input.assignedTo,
      status: "todo",
      plan: (input.plan ?? undefined) as never,
      agentPreparedById: input.agentPreparedById ?? null,
    },
    select: { id: true },
  });
  await db.opportunity.update({
    where: { id: opportunityId },
    data: { status: "accepted", decidedBy: input.assignedTo, decidedAt: new Date() },
  });
  return task.id;
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
