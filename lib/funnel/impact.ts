/**
 * Impact assessment (plan P6).
 *
 * The old score was `volume × CTR-at-current-position × business value × win
 * probability / effort`, saturated to 0–100. It looked like an expected return but
 * was none: it counted clicks the site already gets, multiplied a monthly search
 * volume by a curve meant for a different question, and filled unknown demand with
 * a declared 120 searches/month. A query observed twice reached the top of a board
 * because a provider estimated 3,600 searches for the phrase.
 *
 * This module answers the question the board actually asks — "what changes if we
 * do this?" — and says when it cannot:
 *
 *   incremental clicks = reachable impressions × (target CTR − current CTR)
 *
 * `reachable impressions` is what the site already shows up for (first-party) or
 * what a provider says the market searches (provider). They are separate
 * scenarios, never summed, because one is observed and the other is estimated.
 */

export type ImpactBasis = "first_party_impressions" | "provider_volume" | "none";

export type ImpactAssessment = {
  /**
   * `measured` — first-party impressions and clicks were observed;
   * `estimated` — a provider volume and a position scenario;
   * `technical` — a page or site defect whose traffic impact is not quantifiable;
   * `hypothesis` — no demand evidence; the idea still needs validating.
   */
  kind: "measured" | "estimated" | "technical" | "hypothesis";
  basis: ImpactBasis;
  /** Clicks per month the play could add, or null when it cannot be computed. */
  incrementalClicksPerMonth: number | null;
  /** Every number the estimate rests on, so it can be argued with. */
  assumptions: {
    reachableImpressions: number | null;
    currentCtr: number | null;
    targetCtr: number | null;
    currentPosition: number | null;
    targetPosition: number | null;
    windowDays: number | null;
    monthlyFactor: number | null;
  };
  /** What the estimate does not include. Never empty for an estimate. */
  limitations: string[];
};

export type ImpactInput = {
  volume: number | null;
  volumeSource?: "first_party" | "provider" | "impact_proxy" | "unknown";
  /** Observed CTR, when the source recorded clicks and impressions. */
  observedCtr?: number | null;
  /** Current average position, when observed. */
  currentPosition?: number | null;
  /** The position the play is expected to reach. */
  targetPosition?: number | null;
  /** Days the impressions cover, for a first-party window. */
  windowDays?: number | null;
  /** A defect: severity in 0–1, used only to order technical work. */
  severity?: number | null;
  /** A page defect's traffic impact is not quantifiable from page counts. */
  technical?: boolean;
};

/** CTR curve by position, used only for a provider scenario with no observed CTR. */
export function ctrCurve(position: number | null): number | null {
  if (position == null || position <= 0) return null;
  if (position <= 1) return 0.28;
  if (position <= 3) return 0.15;
  if (position <= 5) return 0.08;
  if (position <= 10) return 0.04;
  if (position <= 20) return 0.015;
  return 0.005;
}

/**
 * Assess the incremental impact of a play.
 *
 * A first-party scenario uses the observed CTR as the baseline, so a page already
 * earning clicks is not credited with all of them. A provider scenario has no
 * observed CTR, so it uses the curve at the current position and says so.
 */
export function assessImpact(input: ImpactInput): ImpactAssessment {
  const limitations: string[] = [];

  if (input.technical) {
    return {
      kind: "technical",
      basis: "none",
      incrementalClicksPerMonth: null,
      assumptions: emptyAssumptions(),
      limitations: [
        "a page or site defect has no demand of its own; its traffic impact is not quantified",
        "priority comes from severity and the number of eligible pages, not from estimated clicks",
      ],
    };
  }

  const source = input.volumeSource ?? "unknown";
  const volume = input.volume;
  if (volume == null || volume <= 0) {
    return {
      kind: "hypothesis",
      basis: "none",
      incrementalClicksPerMonth: null,
      assumptions: emptyAssumptions(),
      limitations: [
        "no demand evidence: neither a provider volume nor first-party impressions",
        "validate the query before treating this as a priority",
      ],
    };
  }

  const targetPosition = input.targetPosition ?? null;
  const targetCtr = ctrCurve(targetPosition);
  if (targetCtr == null) {
    return {
      kind: "hypothesis",
      basis: "none",
      incrementalClicksPerMonth: null,
      assumptions: emptyAssumptions(),
      limitations: ["no target position was declared, so the upside cannot be computed"],
    };
  }

  if (source === "first_party") {
    const windowDays = input.windowDays ?? null;
    const monthlyFactor = windowDays && windowDays > 0 ? 30 / windowDays : null;
    const currentCtr = input.observedCtr ?? ctrCurve(input.currentPosition ?? null);
    if (currentCtr == null || monthlyFactor == null) {
      return {
        kind: "hypothesis",
        basis: "none",
        incrementalClicksPerMonth: null,
        assumptions: emptyAssumptions(),
        limitations: ["the observed window or CTR is missing, so the upside cannot be computed"],
      };
    }
    const incrementalClicksPerMonth = volume * Math.max(0, targetCtr - currentCtr) * monthlyFactor;
    limitations.push(
      "reachable impressions are the impressions already observed for this query/page, not the whole market",
      "a ranking change does not guarantee the CTR curve: snippets, AI answers and ads change it"
    );
    return {
      kind: "measured",
      basis: "first_party_impressions",
      incrementalClicksPerMonth,
      assumptions: {
        reachableImpressions: volume,
        currentCtr,
        targetCtr,
        currentPosition: input.currentPosition ?? null,
        targetPosition,
        windowDays,
        monthlyFactor,
      },
      limitations,
    };
  }

  if (source === "provider") {
    const currentCtr = input.observedCtr ?? ctrCurve(input.currentPosition ?? null);
    const baseline = currentCtr ?? 0;
    const incrementalClicksPerMonth = volume * Math.max(0, targetCtr - baseline);
    limitations.push(
      "provider volume is the size of the market, not the impressions this site can reach",
      "the estimate assumes the site can hold the target position for the whole volume"
    );
    return {
      kind: "estimated",
      basis: "provider_volume",
      incrementalClicksPerMonth,
      assumptions: {
        reachableImpressions: volume,
        currentCtr: currentCtr ?? null,
        targetCtr,
        currentPosition: input.currentPosition ?? null,
        targetPosition,
        windowDays: null,
        monthlyFactor: null,
      },
      limitations,
    };
  }

  // `impact_proxy` and `unknown` are declared stand-ins, not demand.
  return {
    kind: "hypothesis",
    basis: "none",
    incrementalClicksPerMonth: null,
    assumptions: emptyAssumptions(),
    limitations: ["the demand value is a declared proxy, not a measurement"],
  };
}

function emptyAssumptions(): ImpactAssessment["assumptions"] {
  return {
    reachableImpressions: null,
    currentCtr: null,
    targetCtr: null,
    currentPosition: null,
    targetPosition: null,
    windowDays: null,
    monthlyFactor: null,
  };
}

/**
 * The target position a play is expected to reach, by play type. Declared, so a
 * change to the assumption is visible rather than buried in a formula.
 */
export const TARGET_POSITION: Record<string, number> = {
  O1_winnable_rank: 3,
  O2_striking_distance: 8,
  O3_content_gap: 10,
  O4_aeo_citation_gap: 5,
  O5_aeo_presence_gap: 5,
  O6_business_fact_mismatch: 5,
  O7_technical_defect: 5,
  O8_structured_data_gap: 5,
  O9_backlink_gap: 5,
  O10_cannibalization: 5,
  O11_freshness_decay: 5,
  O12_page_experience: 5,
  O13_user_pain_point: 10,
  O14_offer_positioning_gap: 10,
};
