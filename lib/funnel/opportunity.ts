import { type EdgeRelation, type EvidenceLeg, type OpportunityDimension, type OpportunityStatus, type OpportunityType, type Prisma, type PrismaClient } from "@prisma/client";

import { addEdge, type EdgeDb } from "@/lib/funnel/edges";
import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

/**
 * Opportunity store (docs/seo-funnel-spine-plan.md §2/§4).
 *
 * Invariants enforced here:
 *  - an opportunity requires at least one supporting evidence edge;
 *  - dedup by (projectId, dedupKey): the same keyword+URL across detectors is
 *    one opportunity — edges merge, no duplicates;
 *  - score components are stored, declared, recomputable;
 *  - acceptance/parking/rejection is a human decision, recorded;
 *  - hysteresis: below-threshold detected opportunities park, they do not
 *    flicker or disappear.
 */

export type OpportunityDb = EdgeDb & Pick<PrismaClient, "opportunity">;

export type UpsertOpportunityInput = {
  projectId: string;
  type: OpportunityType;
  dimension: OpportunityDimension;
  title: string;
  summary: string;
  dedupKey: string;
  detectedBy: string;
  clusterId?: string | null;
  scoreInputs: Omit<ScoreInputs, "evidenceCompleteness">;
  /** evidence record ids on the why leg (business/knowledge) */
  whyEvidenceIds: string[];
  /** evidence record ids on the how leg (search/technical) */
  howEvidenceIds: string[];
};

const TYPE_DIMENSION: Record<OpportunityType, OpportunityDimension> = {
  O1_winnable_rank: "seo",
  O2_striking_distance: "seo",
  O3_content_gap: "content",
  O4_aeo_citation_gap: "aeo",
  O5_aeo_presence_gap: "aeo",
  O6_business_fact_mismatch: "technical",
  O7_technical_defect: "technical",
  O8_structured_data_gap: "technical",
  O9_backlink_gap: "seo",
  O10_cannibalization: "seo",
  O11_freshness_decay: "seo",
  O12_page_experience: "technical",
  O13_user_pain_point: "content",
  O14_offer_positioning_gap: "content",
};

export function completenessLeg(whyCount: number, howCount: number): EvidenceLeg {
  if (whyCount > 0 && howCount > 0) return "both";
  if (whyCount > 0) return "why";
  if (howCount > 0) return "how";
  return "none";
}

export async function upsertOpportunity(
  db: OpportunityDb,
  input: UpsertOpportunityInput
): Promise<{ id: string; status: OpportunityStatus; created: boolean }> {
  if (!input.whyEvidenceIds.length && !input.howEvidenceIds.length) {
    throw new Error(`opportunity ${input.dedupKey} has no supporting evidence (invariant: no orphan opportunities)`);
  }
  if (input.dimension !== TYPE_DIMENSION[input.type]) {
    throw new Error(`opportunity type ${input.type} has fixed dimension ${TYPE_DIMENSION[input.type]}`);
  }

  const existing = await db.opportunity.findUnique({
    where: { projectId_dedupKey: { projectId: input.projectId, dedupKey: input.dedupKey } },
    select: { id: true, status: true, evidenceCompleteness: true },
  });

  // A refresh re-detects one leg and knows nothing about the other: the detectors
  // pass `howEvidenceIds: []` because the how leg is attached later by the join
  // runner. Recomputing from the detector's input alone demoted every joined
  // opportunity back to why-only on the next research pass — 23 of them in one
  // refresh, with their join edges still in the graph. A leg, once attached, is
  // only removed deliberately, never by a refresh that did not look at it.
  const heldLeg = existing?.evidenceCompleteness;
  const heldWhy = heldLeg === "both" || heldLeg === "why" ? 1 : 0;
  const heldHow = heldLeg === "both" || heldLeg === "how" ? 1 : 0;
  const leg = completenessLeg(
    Math.max(input.whyEvidenceIds.length, heldWhy),
    Math.max(input.howEvidenceIds.length, heldHow)
  );
  const { scoreValue, inputs } = computeScore({ ...input.scoreInputs, evidenceCompleteness: leg });

  const record = existing
    ? await db.opportunity.update({
        where: { id: existing.id },
        data: {
          title: input.title,
          summary: input.summary,
          clusterId: input.clusterId ?? undefined,
          scoreValue,
          scoreInputs: inputs as unknown as Prisma.InputJsonValue,
          evidenceCompleteness: leg,
          lastScoredAt: new Date(),
        },
        select: { id: true, status: true },
      })
    : await db.opportunity.create({
        data: {
          projectId: input.projectId,
          type: input.type,
          dimension: TYPE_DIMENSION[input.type],
          title: input.title,
          summary: input.summary,
          dedupKey: input.dedupKey,
          clusterId: input.clusterId ?? null,
          scoreValue,
          scoreInputs: inputs as unknown as Prisma.InputJsonValue,
          evidenceCompleteness: leg,
          detectedBy: input.detectedBy,
          lastScoredAt: new Date(),
        },
        select: { id: true, status: true },
      });

  for (const evidenceId of input.whyEvidenceIds) {
    await addEdge(db, {
      fromType: "evidence_record",
      fromId: evidenceId,
      toType: "opportunity",
      toId: record.id,
      relation: "supporting",
      createdBy: input.detectedBy,
    });
  }
  for (const evidenceId of input.howEvidenceIds) {
    await addEdge(db, {
      fromType: "evidence_record",
      fromId: evidenceId,
      toType: "opportunity",
      toId: record.id,
      relation: "supporting",
      createdBy: input.detectedBy,
    });
  }

  return { id: record.id, status: record.status, created: !existing };
}

/** Parks the system applied. A human park uses its own reason and is left alone. */
export const SYSTEM_PARK_REASONS = ["score_below_threshold", "cap"] as const;
/** `superseded` is not restorable: the detector no longer emits the key. */
const RESTORABLE_PARK_REASONS = [...SYSTEM_PARK_REASONS];

/**
 * Hysteresis: park detected opportunities that fall below their threshold, and
 * restore ones whose score recovered.
 *
 * Without the restore half, a row parked at score 1 stays parked after the
 * evidence improves — which is how 5 opportunities with scores 27–43 sat on the
 * board as "below threshold".
 */
export async function applyHysteresis(
  db: OpportunityDb,
  opts: { projectId: string; threshold: number; detectedBy: string }
): Promise<string[]> {
  const drifting = await db.opportunity.findMany({
    where: { projectId: opts.projectId, status: "detected", scoreValue: { lt: opts.threshold } },
    select: { id: true },
  });
  for (const row of drifting) {
    await db.opportunity.update({
      where: { id: row.id },
      data: { status: "parked", parkReason: "score_below_threshold", decidedBy: opts.detectedBy, decidedAt: new Date() },
    });
  }
  const recovered = await db.opportunity.findMany({
    where: {
      projectId: opts.projectId,
      status: "parked",
      parkReason: { in: RESTORABLE_PARK_REASONS },
      scoreValue: { gte: opts.threshold },
    },
    select: { id: true },
  });
  if (recovered.length > 0) {
    await db.opportunity.updateMany({
      where: { id: { in: recovered.map((row) => row.id) } },
      data: { status: "detected", parkReason: null, decidedBy: null, decidedAt: null },
    });
  }
  return [...drifting.map((row) => row.id), ...recovered.map((row) => row.id)];
}

export type HumanDecision = "accepted" | "parked" | "rejected" | "closed";

/** Accept/park/reject/close is a human call, always recorded. */
export async function decideOpportunity(
  db: OpportunityDb,
  id: string,
  decision: HumanDecision,
  decidedBy: string,
  reason?: string
): Promise<void> {
  const status: OpportunityStatus =
    decision === "accepted" ? "accepted" : decision === "parked" ? "parked" : decision === "rejected" ? "rejected" : "closed";
  await db.opportunity.update({
    where: { id },
    data: { status, decidedBy, decidedAt: new Date(), parkReason: reason ?? null },
  });
}

export async function edgesSupportingOpportunity(db: EdgeDb, opportunityId: string, relation: EdgeRelation = "supporting") {
  const { incoming } = await (await import("@/lib/funnel/edges")).edgesFor(db, { type: "opportunity", id: opportunityId });
  return incoming.filter((edge) => edge.relation === relation);
}
