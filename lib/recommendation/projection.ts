import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";
import {
  decisionFingerprint,
  hashValue,
  type RecommendationDecision,
} from "@/lib/recommendation/contracts";

/**
 * One pure projection from a validated decision to the opportunity read model.
 *
 * Publish, shadow comparison and rollback verification all use this module, so a
 * shadow report cannot describe a different row from the one an apply would write.
 */

const POSITIONING_TYPES = new Set([
  "COMPETITOR",
  "POSITIONING",
  "MARKET_GAP",
  "OPPORTUNITY",
  "POSITIONING_GAP",
  "COMPETITOR_GAP",
]);

export type EvidenceLeg = "both" | "why" | "how" | "none";

export type OpportunityProjection = {
  projectId: string;
  type: "O13_user_pain_point" | "O14_offer_positioning_gap";
  dimension: "content";
  title: string;
  summary: string;
  dedupKey: string;
  scoreInputs: ScoreInputs;
  recommendationDecision: RecommendationDecision;
  recommendationVersion: string;
  recommendationFingerprint: string;
  recommendationEvidenceId: string | null;
};

export function decisionOpportunityType(
  findingType: string
): "O13_user_pain_point" | "O14_offer_positioning_gap" {
  return POSITIONING_TYPES.has(findingType.toUpperCase()) ? "O14_offer_positioning_gap" : "O13_user_pain_point";
}

export function fallbackDedupKey(findingType: string, findingId: string): string {
  return `${findingType.toUpperCase().includes("POSITION") ? "O14" : "O13"}:${findingId}`;
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
 * proposal are copied from the canonical decision.
 */
export function scoreInputsFromDecision(decision: RecommendationDecision, evidenceCompleteness: EvidenceLeg = "none") {
  const targets = decisionTargetPages(decision);
  const benefit = decision.benefits[0];
  return {
    evidenceCompleteness,
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
      needEvidenceUrls: decision.question.bases.flatMap((basis) => basis.references),
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
      playTypeBase:
        decision.effort.size === "small" ? 5 : decision.effort.size === "medium" ? 15 : decision.effort.size === "large" ? 40 : 15,
      sizeFactor: 1,
    },
    freshness: 1,
    stability: 1,
  };
}

export function projectDecision(input: {
  decision: RecommendationDecision;
  findingType: string;
  projectId: string;
  evidenceId: string | null;
  evidenceCompleteness?: EvidenceLeg;
}): OpportunityProjection {
  const { decision } = input;
  return {
    projectId: input.projectId,
    type: decisionOpportunityType(input.findingType),
    dimension: "content",
    title: decision.question.text.slice(0, 240),
    summary: decision.question.rationale.slice(0, 4_000),
    dedupKey: decision.dedupKey,
    scoreInputs: computeScore(scoreInputsFromDecision(decision, input.evidenceCompleteness ?? "none")).inputs,
    recommendationDecision: decision,
    recommendationVersion: decision.schemaVersion,
    recommendationFingerprint: decisionFingerprint({
      packetHash: decision.packetHash,
      policyVersion: decision.policyVersion,
      promptVersion: decision.promptVersion,
      model: decision.model,
    }),
    recommendationEvidenceId: input.evidenceId,
  };
}

/**
 * The full decision content that a reader or reviewer can observe.
 *
 * Identity and assessment time are excluded because every reassessment creates a
 * new id and timestamp. Everything else, including the packet hash, policy,
 * prompt, model, limitations, coverage, reviews and evidence, is compared.
 */
export function decisionContent(decision: RecommendationDecision): unknown {
  const { decisionId, assessedAt, ...content } = decision;
  void decisionId;
  void assessedAt;
  return content;
}

export function decisionContentHash(decision: RecommendationDecision): string {
  return hashValue(decisionContent(decision));
}

export function decisionsEquivalent(a: RecommendationDecision | null, b: RecommendationDecision | null): boolean {
  if (!a || !b) return a === b;
  return decisionContentHash(a) === decisionContentHash(b);
}
