import type { PrismaClient } from "@prisma/client";

import { upsertOpportunity, type OpportunityDb } from "@/lib/funnel/opportunity";
import { type RecommendationDecision } from "@/lib/recommendation/contracts";
import { projectDecision } from "@/lib/recommendation/projection";

/**
 * Publish one validated decision into the existing opportunity read model.
 *
 * This is projection, not another decision. It never changes readiness,
 * intervention, targets, benefits or uncertainty. Rejected and no-action outcomes
 * park an existing detected row instead of leaving an old premise visible.
 */

export type PublishDb = OpportunityDb & Pick<PrismaClient, "opportunity">;

export {
  decisionOpportunityType,
  decisionTargetPages,
  scoreInputsFromDecision,
  type OpportunityProjection,
} from "@/lib/recommendation/projection";

export async function publishDecision(
  db: PublishDb,
  input: {
    projectId: string;
    decision: RecommendationDecision;
    findingType: string;
    evidenceId: string;
    /** The evidence record this decision supersedes, when it is a reassessment. */
    previousEvidenceId?: string | null;
  }
): Promise<{ published: boolean; opportunityId: string | null }> {
  const { decision } = input;
  const projection = projectDecision({
    decision,
    findingType: input.findingType,
    projectId: input.projectId,
    evidenceId: input.evidenceId,
    // publishDecision always supplies the why evidence and no how evidence; an
    // existing opportunity keeps a previously attached how leg in upsertOpportunity.
    evidenceCompleteness: "why",
  });
  const fingerprint = projection.recommendationFingerprint;

  if (decision.readiness === "rejected" || decision.readiness === "no_action") {
    const existing = await db.opportunity.findUnique({
      where: { projectId_dedupKey: { projectId: input.projectId, dedupKey: decision.dedupKey } },
      select: { id: true, status: true },
    });
    // Legacy rows may have been created under an older dedup key. The evidence edge
    // still identifies the opportunity this finding produced.
    const linked = await db.evidenceEdge.findMany({
      where: {
        fromType: "evidence_record",
        fromId: { in: [input.evidenceId, input.previousEvidenceId].filter((id): id is string => Boolean(id)) },
        toType: "opportunity",
      },
      select: { toId: true },
    });
    const ids = new Set<string>(linked.map((edge) => edge.toId));
    if (existing) ids.add(existing.id);
    for (const id of ids) {
      const row = await db.opportunity.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!row) continue;
      const decisionFields = {
        recommendationDecision: decision as never,
        recommendationVersion: decision.schemaVersion,
        recommendationFingerprint: fingerprint,
        recommendationEvidenceId: input.evidenceId,
        decidedBy: "recommendation-producer",
        decidedAt: new Date(),
      };
      if (row.status === "detected") {
        await db.opportunity.update({
          where: { id: row.id },
          data: {
            ...decisionFields,
            status: "parked",
            parkReason: `decision_${decision.readiness}`,
          },
        });
      } else if (row.status === "accepted" || row.status === "in_progress") {
        // The accepted task keeps its immutable snapshot. The opportunity still
        // records the new rejected/no-action assessment so the page can show that
        // the premise changed instead of hiding it behind a stale decision.
        await db.opportunity.update({
          where: { id: row.id },
          data: decisionFields,
        });
      }
    }
    return { published: false, opportunityId: existing?.id ?? null };
  }

  // A legacy row for this finding may have a different dedup key. Once the finding
  // has a canonical actionable decision, the unassessed legacy placeholder must not
  // remain as a second recommendation.
  const linked = await db.evidenceEdge.findMany({
    where: {
      fromType: "evidence_record",
      fromId: { in: [input.evidenceId, input.previousEvidenceId].filter((id): id is string => Boolean(id)) },
      toType: "opportunity",
    },
    select: { toId: true },
  });
  for (const edge of linked) {
    const row = await db.opportunity.findUnique({ where: { id: edge.toId }, select: { id: true, dedupKey: true, status: true } });
    if (!row || row.status !== "detected" || row.dedupKey === decision.dedupKey) continue;
    await db.opportunity.update({
      where: { id: row.id },
      data: {
        status: "parked",
        parkReason: "superseded_by_decision",
        decidedBy: "recommendation-producer",
        decidedAt: new Date(),
      },
    });
  }

  const result = await upsertOpportunity(db, {
    ...projection,
    detectedBy: "recommendation-producer",
    whyEvidenceIds: [input.evidenceId],
    howEvidenceIds: [],
  });
  return { published: true, opportunityId: result.id };
}
