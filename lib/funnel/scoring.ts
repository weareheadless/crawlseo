import type { EvidenceLeg } from "@prisma/client";

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
  /** separate multipliers, never folded into one number silently */
  evidenceCompleteness: EvidenceLeg; // which legs hold
  freshness: number; // 0–1, decays with evidence age
  stability: number; // 0–1, rank oscillation of the keyword/cluster
};

export type ScoreResult = {
  scoreValue: number;
  inputs: ScoreInputs;
};

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
  // Declared defaults for unknown inputs (plan §2.3): missing demand data is
  // "unknown", never zero — otherwise one-legged business opportunities
  // (worth not yet measured) would always score 0 and hysteresis would park
  // exactly the opportunities the join scheduler is supposed to lift.
  const volume = inputs.worth.volume ?? 120;
  const ctr = inputs.worth.ctrAtPosition ?? 0.03;
  const uplift = inputs.worth.uplift ?? 1;
  const rawWorth = volume * ctr * inputs.worth.businessValue * uplift;

  const effort = Math.max(inputs.effort.playTypeBase * inputs.effort.sizeFactor, 0.5);

  // Unmeasured demand is not low demand, but it is not demand either. Score it as a
  // cheap hygiene task, capped well below anything with evidence behind it, so it
  // stays on the board as work to do without competing with real opportunities.
  if (inputs.worth.unmeasured) {
    // Capped below anything measured: this is a backlog item, not a bet.
    const hygiene = (1 / (1 + effort)) * Math.max(inputs.freshness, 0) * 0.15;
    return { scoreValue: Math.max(0, Math.min(5, Math.round(hygiene * 100))), inputs };
  }

  const winProb = geometricMean([
    inputs.winProbability.rankDistance,
    inputs.winProbability.authorityGap,
    inputs.winProbability.pageStrength,
    inputs.winProbability.serpCompetition,
    inputs.winProbability.playTypeFactor,
  ]);

  const base = rawWorth > 0 && winProb ? (rawWorth * winProb) / effort : 0;

  const score = base
    * LEG_COMPLETENESS_MULTIPLIER[inputs.evidenceCompleteness]
    * Math.max(inputs.freshness, 0)
    * Math.max(inputs.stability, 0);

  // The raw ratio is unbounded (worth is linear in volume), so a site with real
  // demand pinned every opportunity at the 0-100 ceiling and the ranking stopped
  // meaning anything. A saturating curve keeps the order and the scale; the raw
  // components stay stored, so the score is still recomputable.
  const scaled = score > 0 ? score / (score + 1) : 0;
  return {
    scoreValue: Math.max(0, Math.min(100, Math.round(scaled * 100))),
    inputs,
  };
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
