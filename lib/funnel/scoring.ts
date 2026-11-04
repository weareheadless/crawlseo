import type { EvidenceLeg } from "@prisma/client";

import { assessImpact, type ImpactAssessment } from "@/lib/funnel/impact";

/**
 * Scoring model (docs/seo-funnel-spine-plan.md §2.3).
 *
 *   score = worth × win_probability / effort      (0–100, with components)
 *
 * Every input is declared, stored and recomputable. The detector computes the
 * score; synthesis never re-scores (DS-17 re-scope).
 */

export type ScoreInputs = {
  /** worth = volume × CTR-at-position × business_value */
  worth: {
    volume: number | null; // searches/month (provider), or proxy from GSC impressions
    ctrAtPosition: number | null; // 0–1
    businessValue: number; // 0–1, from the why leg (knowledge/research grounding)
    /**
     * Where `volume` came from. `impact_proxy` is the declared stand-in for a
     * page-level defect with no recorded traffic; it is not a search volume and
     * must stay visible (plan §2.3).
     */
    volumeSource?: "first_party" | "provider" | "impact_proxy" | "unknown";
    /**
     * The demand itself is invented, not measured: a question generated from
     * business knowledge that nobody has been shown to search. Scoring it on the
     * same curve as a measured query put 30–42 points on questions with no evidence
     * anyone asks them.
     */
    unmeasured?: boolean;
    /**
     * The share of the traffic at stake that the fix can plausibly recover.
     *
     * A page defect does not put all of that page's traffic at risk; adding schema
     * to 513 pages is hygiene, not the recovery of every impression on them. Without
     * this, page count alone drove a structural fix to the top of the board.
     */
    uplift?: number;
    businessValueSource?: "knowledge" | "cluster" | "topic" | "unknown";
    /** Current average position, when it was observed rather than assumed. */
    currentPosition?: number | null;
    /** The position the play is expected to reach; defaults by play type. */
    targetPosition?: number | null;
    /** Days the demand figure covers, when it is a first-party window. */
    windowDays?: number | null;
    /** Observed CTR, so a page already earning clicks is not credited with them. */
    observedCtr?: number | null;
    /** A defect's severity, used to order technical work without inventing clicks. */
    severity?: number | null;
    /** Impressions actually observed for the query, which bound the upside. */
    observedImpressions?: number | null;
    /** Marks a page/site defect whose traffic impact is not quantifiable. */
    technical?: boolean;
    /** Decision readiness from the recommendation contract, when it was decided. */
    readiness?: "actionable" | "needs_investigation" | "research_backlog" | "no_action" | "rejected";
    /** How the benefit is known. */
    measurement?: "observed_baseline" | "forecast" | "unquantified";
    /** Which value track the work belongs to. */
    benefitTrack?: "customer_value" | "organic_growth" | "technical_health";
    /** What the work does. */
    intervention?: "maintain" | "update_page" | "improve_journey" | "create_asset" | "investigate" | "technical_fix";
    /** The specific change, so accepting the work produces a brief, not a title. */
    change?: string;
    /** How the owner will know it worked. */
    successMeasure?: string;
    /** Pages the work would change. */
    targetPages?: string[];
    /** What the site already does about the need, in one line. */
    coverageSummary?: string;
    /** Why the need itself is supported, and by which sources. */
    needRationale?: string;
    needEvidenceUrls?: string[];
    /** Why this business should serve the need, and by which facts. */
    offerFitRationale?: string;
    offerFitEvidenceUrls?: string[];
    /** Which assessment produced this decision. */
    assessmentModel?: string;
    assessmentPromptVersion?: string;
    assessedAt?: string;
  };
  /** win probability components (0–1 each) */
  winProbability: {
    rankDistance: number | null; // closeness to a winnable position
    authorityGap: number | null; // 1 - (their referring domains - ours) normalized
    pageStrength: number | null;
    serpCompetition: number | null; // 1 - strength of competitors above us
    playTypeFactor: number; // per play type
  };
  /** effort = play-type base × size */
  effort: {
    playTypeBase: number; // hours-equivalent
    sizeFactor: number; // 0.25 (tiny) … 3 (large)
  };
  /**
   * The impact assessment the priority index was computed from. Stored with the
   * inputs so a board can show measured/estimated/technical/hypothesis, and so an
   * assessment can be re-derived and compared across versions.
   */
  assessment?: ImpactAssessment;
  /** Version of the assessment model, so an old index is identifiable. */
  assessmentVersion?: number;
  /** separate multipliers, never folded into one number silently */
  evidenceCompleteness: EvidenceLeg; // which legs hold
  freshness: number; // 0–1, decays with evidence age
  stability: number; // 0–1, rank oscillation of the keyword/cluster
};

export type ScoreResult = {
  /** Compatibility priority index (0–100). Not a probability or a return. */
  scoreValue: number;
  inputs: ScoreInputs;
  /** What the play is expected to change, and what that estimate rests on. */
  impact: ImpactAssessment;
};

/** Bumped when the assessment or index changes meaning. */
export const ASSESSMENT_VERSION = 2;

/** Declared recovery for a technical or structured-data fix. */
export const TECHNICAL_UPLIFT = 0.1;

export const LEG_COMPLETENESS_MULTIPLIER: Record<EvidenceLeg, number> = {
  none: 0.25,
  why: 0.6,
  how: 0.6,
  both: 1.0,
};

export const PLAY_TYPE_EFFORT_BASE: Record<string, number> = {
  O1_winnable_rank: 6,
  O2_striking_distance: 2,
  O3_content_gap: 16,
  O4_aeo_citation_gap: 8,
  O5_aeo_presence_gap: 1,
  O6_business_fact_mismatch: 1,
  O7_technical_defect: 3,
  O8_structured_data_gap: 2,
  O9_backlink_gap: 24,
  O10_cannibalization: 4,
  O11_freshness_decay: 5,
  O12_page_experience: 12,
  O13_user_pain_point: 16,
  O14_offer_positioning_gap: 12,
};

function geometricMean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null && v >= 0);
  if (present.length === 0) return null;
  const product = present.reduce((acc, v) => acc * Math.max(v, 0.01), 1);
  return Math.pow(product, 1 / present.length);
}

export function computeScore(inputs: ScoreInputs): ScoreResult {
  const assessment = assessImpact({
    volume: inputs.worth.volume,
    volumeSource: inputs.worth.volumeSource,
    observedCtr: inputs.worth.observedCtr ?? inputs.worth.ctrAtPosition,
    currentPosition: inputs.worth.currentPosition ?? null,
    targetPosition: inputs.worth.targetPosition ?? null,
    windowDays: inputs.worth.windowDays ?? null,
    severity: inputs.worth.severity ?? null,
    technical: inputs.worth.technical,
    observedImpressions: inputs.worth.observedImpressions ?? null,
  });

  // Readiness comes from the decision contract, not from whether a demand number
  // happens to exist. A supported customer need with unquantified traffic is work a
  // person can accept; a research backlog item is not.
  const readiness = inputs.worth.readiness;
  if (readiness === "rejected") {
    return { scoreValue: 0, inputs: withAssessment(inputs, assessment), impact: assessment };
  }
  const band = readiness === "research_backlog" ? 10
    : readiness === "needs_investigation" ? 15
    : readiness === "actionable" && (inputs.worth.measurement === "unquantified" || assessment.kind === "hypothesis") ? 30
    // Legacy rows predate the contract: unknown demand is a question, not work.
    : readiness == null && assessment.kind === "hypothesis" ? 15
    : null;
  if (band != null || inputs.worth.unmeasured) {
    const ceiling = inputs.worth.unmeasured ? 5 : (band ?? 10);
    const strength =
      Math.max(inputs.freshness, 0) *
      Math.max(inputs.stability, 0) *
      LEG_COMPLETENESS_MULTIPLIER[inputs.evidenceCompleteness] *
      (0.5 + inputs.worth.businessValue / 2);
    return {
      scoreValue: Math.max(0, Math.min(ceiling, Math.round(strength * ceiling))),
      inputs: withAssessment(inputs, assessment),
      impact: assessment,
    };
  }

  // A defect is ordered by severity and reach, never by a fabricated click count.
  if (assessment.kind === "technical") {
    const severity = inputs.worth.severity ?? 0.5;
    const reach = Math.min(1, (inputs.worth.volume ?? 0) / 300);
    const index = 4 + 6 * severity + 4 * reach;
    return {
      scoreValue: Math.max(0, Math.min(14, Math.round(index))),
      inputs: withAssessment(inputs, assessment),
      impact: assessment,
    };
  }

  const clicks = assessment.incrementalClicksPerMonth ?? 0;
  const winProb = geometricMean([
    inputs.winProbability.rankDistance,
    inputs.winProbability.authorityGap,
    inputs.winProbability.pageStrength,
    inputs.winProbability.serpCompetition,
    inputs.winProbability.playTypeFactor,
  ]) ?? 0.5;
  const effort = Math.max(inputs.effort.playTypeBase * inputs.effort.sizeFactor, 0.5);

  // Incremental clicks per month, weighted by the chance of winning and the work
  // involved. The scale constant keeps small sites readable: 10 clicks/month of
  // upside is half of 20, not a rounding error.
  //
  // Relevance is dampened when it is unknown rather than assumed. A site can rank
  // for "hospital near me" by accident; that traffic is real, but it is not the
  // business, and letting it top the board is how a real-estate agent is told to
  // optimise a hospital guide.
  const relevance = inputs.worth.businessValueSource === "knowledge" ? 1 : 0.25;
  const PRIORITY_SCALE_CLICKS = 5;
  const ratio = (clicks * winProb * inputs.worth.businessValue * relevance) / effort;
  const scaled = ratio / (ratio + PRIORITY_SCALE_CLICKS);
  const multiplier =
    LEG_COMPLETENESS_MULTIPLIER[inputs.evidenceCompleteness] *
    Math.max(inputs.freshness, 0) *
    Math.max(inputs.stability, 0);
  const value = scaled * multiplier;

  return {
    scoreValue: Math.max(0, Math.min(100, Math.round(value * 100))),
    inputs: withAssessment(inputs, assessment),
    impact: assessment,
  };
}

/** Store the assessment alongside the inputs it was computed from. */
function withAssessment(inputs: ScoreInputs, assessment: ImpactAssessment): ScoreInputs {
  return { ...inputs, assessment, assessmentVersion: ASSESSMENT_VERSION };
}

/** Default CTR curve by average rank position (banded, declared). */
export function ctrAtPosition(position: number | null): number | null {
  if (position == null) return null;
  if (position <= 1) return 0.28;
  if (position <= 3) return 0.15;
  if (position <= 5) return 0.08;
  if (position <= 10) return 0.04;
  if (position <= 20) return 0.015;
  return 0.005;
}

/** Rank-distance closeness to a winnable position (1 = at top, 0 = nowhere). */
export function rankDistanceFactor(position: number | null): number | null {
  if (position == null) return null;
  if (position <= 0) return null;
  if (position <= 3) return 1.0;
  if (position <= 10) return 0.9 - (position - 3) * 0.05; // 0.9 … 0.55
  if (position <= 20) return 0.5 - (position - 10) * 0.03; // 0.5 … 0.2
  return Math.max(0.05, 0.2 - (position - 20) * 0.01);
}

/** Exponential freshness decay; half-life of 14 days, floored at 0.05. */
export function freshnessFactor(observedAt: Date, now: Date = new Date()): number {
  const ageDays = Math.max(0, (now.getTime() - observedAt.getTime()) / 86_400_000);
  return Math.max(0.05, Math.pow(0.5, ageDays / 14));
}
