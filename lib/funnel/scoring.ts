import type { EvidenceLeg } from "@prisma/client";

import { assessImpact, TARGET_POSITION, type ImpactAssessment } from "@/lib/funnel/impact";

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
     * D3: how this row's demand was resolved.
     *
     * - `observed` — the site's own impressions for the query, so any estimate is grounded.
     * - `candidate` — a discovered topic with provider volume and no present page or SERP.
     *   Its `expectedClicks` is `null` on purpose: nothing about this site's reach for the
     *   query has been measured, so a click estimate would be a projection presented as a
     *   measurement. One $0.004 SERP turns it into `observed`.
     *
     * Absent on legacy rows, which is not the same as `observed` — a reader must not
     * assume a missing marker means the demand was measured.
     */
    demandResolution?: "observed" | "candidate";
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
    /**
     * A SERP snapshot was bought for this query or cluster.
     *
     * The second route to a resolved demand read: a site with no impressions still learns
     * what winning costs, which is what D3 buys the snapshot for. Stored, so the row can
     * explain why it quotes a market it has never been shown for.
     */
    hasSerp?: boolean;
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
  /**
   * CMP-012: where each winnability input came from, and when it was observed.
   *
   * Stored with the score so a board can show measured / estimated / assumed per input
   * instead of presenting a typed-in 0.5 as a fair fight. Absent on rows scored before
   * this existed, which is why every reader must tolerate `undefined` rather than assume
   * provenance is known.
   */
  winProbabilitySource?: Partial<Record<keyof ScoreInputs["winProbability"], "measured" | "estimated" | "assumed">>;
  winProbabilityObservedAt?: Partial<Record<keyof ScoreInputs["winProbability"], string>>;
  /** One line per input that could not be measured, saying what is missing. */
  winProbabilityMissing?: string[];
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
  /**
   * Which kind of evidence the score rests on, as stored in `Opportunity.evidenceClass`.
   * The board is ordered by this before the score, so it is returned with the score
   * rather than re-derived by each writer.
   */
  evidenceClass: ImpactAssessment["kind"];
  /**
   * D3: `null` for a candidate — a topic whose demand has not been measured for this site.
   *
   * The number a candidate has is market size, not reach. Surfacing it as a click estimate
   * is how a page that does not exist scored 38 while a page ranking 29th scored 1.
   */
  expectedClicksPerMonth: number | null;
  /** Whether this row's demand is measured here or is still a candidate. */
  demandResolution: "observed" | "candidate" | "unrecorded";
};

/**
 * Bumped when the assessment or index changes meaning.
 *
 * 3 — the readiness band stopped claiming technical rows, so the same defect with the
 * same inputs scores 6 where it used to score 23. A row carrying 2 was scored by a model
 * that no longer exists: the number is not a priority anyone chose, it is a stale
 * computation, and the board must not present it beside a class badge as if it were
 * current.
 *
 * 4 — the score became a **rate**, and its numerator became the market instead of our
 * current reach. Both change what the number is, not just its value: `observed x CTR
 * delta` measured our visibility, and a bigger site therefore scored higher for identical
 * work. A row carrying 3 was scored on a quantity that no longer means priority, so every
 * row is re-scored rather than compared against the old numbers.
 */
export const ASSESSMENT_VERSION = 4;

/** Declared recovery for a technical or structured-data fix. */
export const TECHNICAL_UPLIFT = 0.1;

/**
 * CMP-012: the winnability inputs that can be measured. `playTypeFactor` is not among them
 * — it is a declared property of the play, so it is `assumed` by design and a row is not
 * penalised for relying on it.
 */
export const MEASURABLE_WIN_INPUTS = ["rankDistance", "authorityGap", "pageStrength", "serpCompetition"] as const;

/**
 * The priority ceiling for a row whose winnability is entirely assumed.
 *
 * Not a drop and not a zero: the work is visible, and visibly low-confidence.
 */
export const ASSUMED_WIN_PROBABILITY_CEILING = 40;

/**
 * The rate of return at which the priority index reaches 100.
 *
 * The index is a log scale of incremental clicks per hour of work, so it needs one anchor
 * or it is an arbitrary curve. 200 clicks/hour is the declared top: a 40-hour project
 * earning 8,000 clicks a month. Ahead of that, a row is not more of the same thing — it is
 * a business change, and it should be judged by a person rather than sorted against content
 * edits.
 *
 * Chosen from the live boards rather than in the abstract: measured 2026-11-25, real rows
 * spread from 0.07 to ~325 clicks/hour, and this anchor puts that whole range inside 10–100
 * so the board keeps its resolution instead of piling at either end.
 */
export const CLICKS_PER_HOUR_AT_CEILING = 200;

export const LEG_COMPLETENESS_MULTIPLIER: Record<EvidenceLeg, number> = {
  none: 0.25,
  why: 0.6,
  how: 0.6,
  both: 1.0,
};

/**
 * How much to trust the business-value estimate behind a row.
 *
 * The source is a fact about where the judgement came from, and the multiplier is
 * what it is worth. Only two of the four sources are a judgement about *this*
 * business: `knowledge` (the owner's or the extractor's facts) and `cluster` (the
 * model's relevance call on a topic it derived from those facts). `topic` and
 * `unknown` are not judgements and must not be treated as one.
 *
 * Measured 2026-11-25: 1,654 of 1,965 rows carried no source at all, and every one
 * of the 102 open rows was in that set, so nearly the whole board was multiplied by
 * the old blanket 0.25. The same apnea row scored 7 with no source and 22 with one.
 */
export const RELEVANCE_BY_SOURCE: Record<NonNullable<ScoreInputs["worth"]["businessValueSource"]>, number> = {
  knowledge: 1,
  cluster: 1,
  topic: 0.6,
  unknown: 0.25,
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

/**
 * The target position declared for this kind of work, or null when none is declared.
 *
 * Deliberately conservative: it maps only the interventions that have an unambiguous entry
 * in `TARGET_POSITION`. A play that reaches a position nobody declared stays unsized, which
 * is honest — a missing goal is a missing decision, not a default of 10.
 */
function declaredTargetPosition(inputs: ScoreInputs): number | null {
  const intervention = inputs.worth.intervention;
  if (intervention === "create_asset") return TARGET_POSITION.O3_content_gap;
  if (intervention === "improve_journey") return TARGET_POSITION.O3_content_gap;
  if (intervention === "update_page") return TARGET_POSITION.O1_winnable_rank;
  return null;
}

function geometricMean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null && v >= 0);
  if (present.length === 0) return null;
  const product = present.reduce((acc, v) => acc * Math.max(v, 0.01), 1);
  return Math.pow(product, 1 / present.length);
}

/**
 * The D3 fields every return carries.
 *
 * Written as a helper so a new early return cannot forget them: a row that omits
 * `demandResolution` reads as "unrecorded", and a candidate that omits it would be
 * presented with a click estimate it does not have.
 */
function demandFields(
  worth: ScoreInputs["worth"],
  assessment: ImpactAssessment
): { expectedClicksPerMonth: number | null; demandResolution: "observed" | "candidate" | "unrecorded" } {
  const demandResolution = worth.demandResolution ?? "unrecorded";
  return {
    expectedClicksPerMonth: demandResolution === "candidate" ? null : assessment.incrementalClicksPerMonth,
    demandResolution,
  };
}

export function computeScore(inputs: ScoreInputs): ScoreResult {
  const assessment = assessImpact({
    volume: inputs.worth.volume,
    volumeSource: inputs.worth.volumeSource,
    observedCtr: inputs.worth.observedCtr ?? inputs.worth.ctrAtPosition,
    currentPosition: inputs.worth.currentPosition ?? null,
    /**
     * The declared target for this kind of play, when the producer did not state one.
     *
     * A null target is not a detail: `assessImpact` needs it to compute anything, so the
     * row lands in the band and is never sized. Measured 2026-11-25, 49 of 117 open rows
     * carried no target position and none of them could be sized no matter how much
     * evidence they had — susimacdonald's whole board read a flat 7 while its rows held
     * 944 observed impressions at position 60 on a 1,230/month market.
     *
     * `TARGET_POSITION` is a declared table keyed by play type, so the fallback is not a
     * guess: it is the same target the producer would have written. Uses `intervention`
     * only when the play type is unknown, and otherwise leaves it null rather than
     * inventing a goal.
     */
    targetPosition: inputs.worth.targetPosition ?? declaredTargetPosition(inputs),
    windowDays: inputs.worth.windowDays ?? null,
    severity: inputs.worth.severity ?? null,
    technical: inputs.worth.technical,
    observedImpressions: inputs.worth.observedImpressions ?? null,
    hasSerp: inputs.worth.hasSerp ?? false,
  });

  // Readiness comes from the decision contract, not from whether a demand number
  // happens to exist. A supported customer need with unquantified traffic is work a
  // person can accept; a research backlog item is not.
  //
  // A defect is not part of that scale. The band pays a fixed share of a ceiling and
  // never reads severity, so a technical row that reached it scored by freshness and
  // completeness alone: measured 2026-11-25, "missing structured data on 48 pages"
  // scored 23 with unquantified demand while the same defect with measured demand
  // took the technical branch below and scored 6. Work with no demand evidence was
  // beating the same work with it. Defects fall through to their own branch, which
  // orders by severity and reach and never invents a click count.
  const readiness = inputs.worth.readiness;
  if (readiness === "rejected") {
    return {
      scoreValue: 0,
      inputs: withAssessment(inputs, assessment),
      impact: assessment,
      evidenceClass: assessment.kind,
      ...demandFields(inputs.worth, assessment),
    };
  }
  /**
   * The band: rows whose demand cannot be sized.
   *
   * The ceiling is deliberately small. A row here has no click estimate, so the number is
   * not a priority — it is a *rank among other unsized rows*, and its job is to keep them
   * orderable without ever competing with work whose upside is known.
   *
   * These ceilings used to be 10 / 15 / 30, which paid 21 points for "we do not know" and
   * put hypotheses above measured rows scoring 5. That is the band paying for ignorance:
   * the log rate scale below can award a genuine 200 clicks/hour a 100, and a row with no
   * demand evidence gets 76% of the old ceiling for having none. Missing evidence is not
   * negative evidence — that is handled by labelling the row and placing it last (D1) —
   * but it is not extra credit either, and it must not outrank a sized win.
   */
  /**
   * A finding with measured demand is not `unmeasured`, and must not be capped like one.
   *
   * `unmeasured` means the demand figure itself is invented — a question generated from
   * business knowledge that nobody has been shown to search. A detector finding (striking
   * distance, cannibalisation, a winnable rank) is the opposite: its demand is measured, and
   * only its *fix* is unquantified.
   *
   * Those were sharing the lowest ceiling, which is how 371 parked rows came to hold 282 real
   * findings beside 89 invented ones. The distinction is the one the whole file is about, so
   * it is read from the inputs rather than inferred from readiness.
   */
  const measuredDemand = inputs.worth.measurement === "observed_baseline" || (inputs.worth.volume ?? 0) > 0;
  const band = inputs.worth.technical ? null
    : readiness === "research_backlog" ? 4
    : readiness === "needs_investigation" ? (measuredDemand ? 12 : 6)
    : readiness === "actionable" && (inputs.worth.measurement === "unquantified" || assessment.kind === "hypothesis") ? (measuredDemand ? 18 : 10)
    // Legacy rows predate the contract. A legacy row that measured its demand is real work
    // whose fix is unquantified; one that did not is a question. Same split.
    : readiness == null && assessment.kind === "hypothesis" ? (measuredDemand ? 12 : 6)
    : null;
  if ((band != null || inputs.worth.unmeasured) && !inputs.worth.technical) {
    const ceiling = inputs.worth.unmeasured ? 3 : (band ?? 6);
    const strength =
      Math.max(inputs.freshness, 0) *
      Math.max(inputs.stability, 0) *
      LEG_COMPLETENESS_MULTIPLIER[inputs.evidenceCompleteness] *
      (0.5 + inputs.worth.businessValue / 2);
    return {
      scoreValue: Math.max(0, Math.min(ceiling, Math.round(strength * ceiling))),
      inputs: withAssessment(inputs, assessment),
      impact: assessment,
      evidenceClass: assessment.kind,
      ...demandFields(inputs.worth, assessment),
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
      evidenceClass: assessment.kind,
      ...demandFields(inputs.worth, assessment),
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
  //
  // The multiplier comes from a declared table, not a binary test: `knowledge` and
  // `cluster` are both judgements grounded in the business's own facts, `topic` is
  // weaker, and a genuinely unknown source is still damped but as its own state
  // rather than as a stand-in for every other source.
  const relevance =
    RELEVANCE_BY_SOURCE[inputs.worth.businessValueSource ?? "unknown"] ?? 0.25;
  /**
   * Priority is value per hour of work, on a declared log scale.
   *
   * The numerator is the incremental clicks the play could add (a market-sized number,
   * see `assessImpact`), weighted by the chance of winning it and by what those clicks are
   * worth to this business. The denominator is the effort the play type costs. So the
   * number answers the one question a person with a month of time is actually asking:
   * which hour buys the most.
   *
   * It is a *rate*, not a return. A return makes priority a function of how big the site
   * already is — measured 2026-11-25, holding the play constant (rank 29 -> 10, same
   * effort) a site with 76 impressions scored 3 and one with 7,600 scored 40. A rate with
   * the market as its numerator does not do that, and that is the whole point: for a site
   * trying to grow, the marginal hour is worth most where it has the most room.
   *
   * The scale is logarithmic because the quantity spans orders of magnitude — a
   * high-volume national query and a niche local one can differ by 1,000x in clicks/hour,
   * and a linear curve would put every row at the ceiling and sort nothing. Against the
   * declared ceiling below it reads: 1 click/hour scores 13, 10 scores 45, 50 scores 74,
   * 200 scores 100.
   */
  const valuePerHour = clicks * winProb * inputs.worth.businessValue * relevance / effort;
  const scaled = valuePerHour <= 0 ? 0 : Math.log10(1 + valuePerHour) / Math.log10(1 + CLICKS_PER_HOUR_AT_CEILING);
  const multiplier =
    LEG_COMPLETENESS_MULTIPLIER[inputs.evidenceCompleteness] *
    Math.max(inputs.freshness, 0) *
    Math.max(inputs.stability, 0);
  const value = scaled * multiplier;

  /**
   * CMP-012: a score whose winnability is entirely assumed must not reach the top band.
   *
   * Measured 2026-11-24: `pageStrength` and `serpCompetition` were the literal 0.5 on all
   * 145 live opportunities, so the board ordered work by volume × rank distance ÷ effort
   * and called the result a fair fight. The ceiling keeps such a row visible — the work is
   * still real — while stopping a number nobody measured from topping the list.
   */
  const lowConfidence = MEASURABLE_WIN_INPUTS.every(
    (key) => (inputs.winProbabilitySource?.[key] ?? "assumed") === "assumed"
  );
  /**
   * The assumed-fight ceiling is a **cap**, not a multiplier.
   *
   * Scaling by the ceiling was tried on 2026-11-25 and reverted: it cut rows that were
   * already below the ceiling (21 to 7), which put measured work underneath the hypothesis
   * band and inverted the one rule the board depends on. A cap is the honest shape — "do not
   * reach the top band" — and it costs nothing for a row that was never going to reach it.
   *
   * It does mean several rows above the ceiling tie at 40 and the number alone cannot order
   * them. That is not a scorer defect to paper over: it is the scorer saying it has no
   * measured winnability for any of them, and the rows it happens to affect on astridrincon
   * are also carrying a national market volume for a local business, which is the real
   * problem (see the market-scope note in the plan).
   */
  const scoreValue = Math.max(0, Math.min(lowConfidence ? ASSUMED_WIN_PROBABILITY_CEILING : 100, Math.round(value * 100)));

  return {
    scoreValue,
    inputs: withAssessment(inputs, assessment),
    impact: assessment,
    // The stored ordering key. Returned here so the two places that write a score
    // cannot disagree about which class it belongs to: they read the same value the
    // score was computed with, rather than re-deriving it from `scoreInputs`.
    evidenceClass: assessment.kind,
    ...demandFields(inputs.worth, assessment),
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
