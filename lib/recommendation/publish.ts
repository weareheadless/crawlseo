import type { PrismaClient } from "@prisma/client";

import { upsertOpportunity, type OpportunityDb } from "@/lib/funnel/opportunity";
import { decisionFingerprint, type RecommendationDecision } from "@/lib/recommendation/contracts";

/**
 * Publish one validated decision into the existing opportunity read model.
 *
 * This is projection, not another decision. It never changes readiness,
 * intervention, targets, benefits or uncertainty. Rejected and no-action outcomes
 * park an existing detected row instead of leaving an old premise visible.
 */

export type PublishDb = OpportunityDb & Pick<PrismaClient, "opportunity">;

const POSITIONING_TYPES = new Set([
  "COMPETITOR",
  "POSITIONING",
  "MARKET_GAP",
  "OPPORTUNITY",
  "POSITIONING_GAP",
  "COMPETITOR_GAP",
]);

export function decisionOpportunityType(findingType: string): "O13_user_pain_point" | "O14_offer_positioning_gap" {
  return POSITIONING_TYPES.has(findingType.toUpperCase()) ? "O14_offer_positioning_gap" : "O13_user_pain_point";
}

export function decisionTargetPages(decision: RecommendationDecision): string[] {
  return decision.targets
    .map((target) => target.pageUrl)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
}

function coverageSummary(decision: RecommendationDecision): string {
  if (decision.coverage.length === 0) return "no page assessed";
  const strongest = [...decision.coverage].sort((a, b) => {
    const order = ["answers", "partially_answers", "does_not_answer", "unassessable"];
    return order.indexOf(a.state) - order.indexOf(b.state);
  })[0];
  return `${strongest.state.replaceAll("_", " ")} at ${strongest.pageId}`;
}

/**
 * Compatibility score inputs for existing readers.
 *
 * These are deliberately not a second decision: readiness, intervention and the
 * proposal are copied from the canonical decision. New readers use
 * `recommendationDecision` directly.
 */
export function scoreInputsFromDecision(decision: RecommendationDecision) {
  const targets = decisionTargetPages(decision);
  const benefit = decision.benefits[0];
  return {
    worth: {
      volume: null,
      ctrAtPosition: null,
      businessValue: 0.5,
      businessValueSource: "unknown" as const,
      readiness: decision.readiness,
      measurement: benefit?.measurement ?? "unquantified",
      benefitTrack: benefit?.track,
      intervention: decision.intervention,
      change: decision.change ?? undefined,
      successMeasure: decision.success.measure,
      targetPages: targets,
      coverageSummary: coverageSummary(decision),
      needRationale: decision.question.rationale,
      needEvidenceUrls: decision.question.bases.flatMap((basis) =>
        basis.references
      ),
      offerFitRationale: decision.offerFit.rationale,
      offerFitEvidenceUrls: decision.offerFit.references,
      assessmentModel: decision.model,
      assessmentPromptVersion: decision.promptVersion,
      assessedAt: decision.assessedAt,
    },
    winProbability: {
      rankDistance: null,
      authorityGap: null,
      pageStrength: null,
      serpCompetition: null,
      playTypeFactor: 0.5,
    },
    effort: {
      playTypeBase: decision.effort.size === "small" ? 5 : decision.effort.size === "medium" ? 15 : decision.effort.size === "large" ? 40 : 15,
      sizeFactor: 1,
    },
    freshness: 1,
    stability: 1,
  };
}

export async function publishDecision(
  db: PublishDb,
  input: {
    projectId: string;
    decision: RecommendationDecision;
    findingType: string;
    evidenceId: string;
  }
): Promise<{ published: boolean; opportunityId: string | null }> {
  const { decision } = input;
  const fingerprint = decisionFingerprint({
    packetHash: decision.packetHash,
    policyVersion: decision.policyVersion,
    promptVersion: decision.promptVersion,
    model: decision.model,
  });

  if (decision.readiness === "rejected" || decision.readiness === "no_action") {
    const existing = await db.opportunity.findUnique({
      where: { projectId_dedupKey: { projectId: input.projectId, dedupKey: decision.dedupKey } },
      select: { id: true, status: true },
    });
    // Legacy rows may have been created under an older dedup key. The evidence edge
    // still identifies the opportunity this finding produced.
    const linked = await db.evidenceEdge.findMany({
      where: { fromType: "evidence_record", fromId: input.evidenceId, toType: "opportunity" },
      select: { toId: true },
    });
    const ids = new Set<string>(linked.map((edge) => edge.toId));
    if (existing) ids.add(existing.id);
    for (const id of ids) {
      const row = await db.opportunity.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!row || row.status !== "detected") continue;
      await db.opportunity.update({
        where: { id: row.id },
        data: {
          status: "parked",
          parkReason: `decision_${decision.readiness}`,
          recommendationDecision: decision as never,
          recommendationVersion: decision.schemaVersion,
          recommendationFingerprint: fingerprint,
          recommendationEvidenceId: input.evidenceId,
          decidedBy: "recommendation-producer",
          decidedAt: new Date(),
        },
      });
    }
    return { published: false, opportunityId: existing?.id ?? null };
  }

  // A legacy row for this finding may have a different dedup key. Once the finding
  // has a canonical actionable decision, the unassessed legacy placeholder must not
  // remain as a second recommendation.
  const linked = await db.evidenceEdge.findMany({
    where: { fromType: "evidence_record", fromId: input.evidenceId, toType: "opportunity" },
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
    projectId: input.projectId,
    type: decisionOpportunityType(input.findingType),
    dimension: "content",
    title: decision.question.text.slice(0, 240),
    summary: decision.question.rationale.slice(0, 4_000),
    dedupKey: decision.dedupKey,
    detectedBy: "recommendation-producer",
    scoreInputs: scoreInputsFromDecision(decision),
    whyEvidenceIds: [input.evidenceId],
    howEvidenceIds: [],
    recommendationDecision: decision,
    recommendationVersion: decision.schemaVersion,
    recommendationFingerprint: fingerprint,
    recommendationEvidenceId: input.evidenceId,
  });
  return { published: true, opportunityId: result.id };
}
