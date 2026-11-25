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
  /**
   * Impressions the site actually received for this query in the window.
   *
   * This is the reach bound. A provider can say the market searches a phrase 74,000
   * times a month, but if Google showed this site ten times, the upside is bounded
   * by those ten: the rest of the market is not reachable by editing a page.
   */
  observedImpressions?: number | null;
  /** A defect: severity in 0–1, used only to order technical work. */
  severity?: number | null;
  /** A page defect's traffic impact is not quantifiable from page counts. */
  technical?: boolean;
  /**
   * A SERP snapshot was bought for this query or its cluster.
   *
   * This is the second route to a resolved demand read: a site with no impressions at
   * all still learns what winning costs from a $0.004 snapshot, and that is enough to
   * quote the market. Without it, a new site could never size anything.
   */
  hasSerp?: boolean;
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
 * The share of a query's searches in which a result at this average position is seen at
 * all, as opposed to clicked.
 *
 * Declared and deliberately blunt: it is a ceiling on plausibility, not a forecast. Its
 * only job is to stop a market number contradicting our own measurement.
 *
 * A page ranking inside the top ten appears in nearly every search for the query, so its
 * impression count is close to the whole market. A page at position 68 appears in a sliver
 * of them, so its impressions say almost nothing about market size — which is why position,
 * not impressions, decides when the provider's volume can be trusted at full size.
 */
/**
 * The visibility above which our own impression count is a real estimate of the market.
 *
 * 0.7 is the top-ten curve: at that share, seeing a handful of impressions is evidence
 * that the phrase is small rather than evidence that we are invisible. Below it, the
 * censoring is too strong to conclude anything and the provider's figure stands.
 */
export const VISIBILITY_TRUSTED = 0.7;

export function visibilityAtPosition(position: number | null): number {
  if (position == null || position <= 0) return 0.02;
  if (position <= 3) return 0.95;
  if (position <= 10) return 0.7;
  if (position <= 20) return 0.35;
  if (position <= 50) return 0.1;
  return 0.03;
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
  const observed = input.observedImpressions ?? null;

  // Reach first. A query the site is barely shown for is not a large opportunity,
  // however big the market is: 3,600 searches a month against two impressions is a
  // phrase the site does not compete for yet, and the honest next step is to check
  // intent and rank rather than book a 400-click win.
  if (observed != null && observed > 0 && observed < MIN_REACH_IMPRESSIONS && !input.hasSerp) {
    return {
      kind: "hypothesis",
      basis: "none",
      incrementalClicksPerMonth: null,
      assumptions: emptyAssumptions(),
      limitations: [
        `only ${Math.round(observed)} impressions in the window: too little visibility to estimate a win`,
        volume != null ? `a provider estimates ${Math.round(volume)} searches/month, but that is market size, not reachable demand` : "no provider volume either",
      ],
    };
  }
  if (observed != null && observed > 0) {
    const windowDays = input.windowDays ?? null;
    const monthlyFactor = windowDays && windowDays > 0 ? 30 / windowDays : null;
    const targetPosition = input.targetPosition ?? null;
    const targetCtr = ctrCurve(targetPosition);
    const currentCtr = input.observedCtr ?? ctrCurve(input.currentPosition ?? null);
    if (targetCtr == null || currentCtr == null || monthlyFactor == null) {
      return {
        kind: "hypothesis",
        basis: "none",
        incrementalClicksPerMonth: null,
        assumptions: emptyAssumptions(),
        limitations: ["the target position, CTR or window is missing, so the upside cannot be computed"],
      };
    }
    /**
     * The market is the operand; what the site already earns is netted off.
     *
     * This used to be `observed x (targetCtr - currentCtr)`: our own impressions
     * multiplied by a CTR delta. That is bounded by our current visibility, so it
     * answers "what does a better snippet get us" and never "what does ranking get
     * us". Measured 2026-11-25, 'alex karp height' on alaguillotine: the site ranks
     * 68th with 76 impressions, the market is 135,390 searches/month, and the old
     * formula credited 2.85 clicks — a 3-point row. At position 10 those same queries
     * are worth ~5,400.
     *
     * The small impression count is not evidence of a small opportunity; it is the
     * *consequence* of position 68. So the market sizes the win, and the impressions
     * we already get are subtracted rather than used as the ceiling.
     */
    /**
     * The market is the provider's monthly figure, never smaller than what we already see.
     *
     * With thin reach the observed impressions net off to almost nothing, which is correct
     * rather than a discount. The floor matters: when a page already receives more
     * impressions than the provider credits the phrase with (a long-tail cluster, or a
     * provider under-count on a local query), taking the volume as the market would make
     * the win negative and score real work at zero. Measured 2026-11-25 on the apnea row:
     * 4,200 observed impressions against a provider volume of 1,300 produced a negative
     * upside. Our own impressions are a lower bound on the market, so they raise it, and
     * the subtraction then uses the same denominator it is measured against.
     */
    /**
     * The market, reconciled with what our own rank lets us see.
     *
     * Impressions are censored by rank, and the two directions are not symmetric:
     *
     * - **Deep rank.** A page at position 68 is shown for a sliver of the searches the
     *   query gets, so a small impression count says nothing about market size. The
     *   provider's figure stands. Alaguillotine ranks 68th on 'alex karp height' with 76
     *   impressions against a 135,390/month market — that is not a contradiction, it is
     *   exactly what ranking 68th looks like, and cutting the market to the implied 2,500
     *   would abandon a real opportunity.
     * - **Top rank.** A page in the top ten is shown in most searches for the query, so its
     *   impression count *is* an estimate of the market. A provider claiming far more than
     *   we could possibly be shown is describing a broader phrase than the one we rank for.
     *
     * So the provider figure is capped by `observed / visibility(position)` only when the
     * rank is good enough for that observation to be informative. Measured 2026-11-25: a
     * page ranked 4th with 12 impressions and a 74,000 provider volume was credited 11,099
     * clicks/month — a market 6,000x what its own impression count could support.
     *
     * The floor always applies: the market cannot be smaller than what we already see, or a
     * long-tail cluster (4,200 observed against a 1,300 provider volume) yields a negative
     * upside and real work scores zero.
     */
    const observedMonthly = observed * monthlyFactor;
    const visibility = visibilityAtPosition(input.currentPosition ?? null);
    const impliedByRank = observedMonthly / visibility;
    const providerMarket = volume != null && volume > 0 ? volume : 0;
    const observationIsInformative = input.currentPosition != null && visibility >= VISIBILITY_TRUSTED;
    const upper = observationIsInformative ? Math.max(impliedByRank, observedMonthly) : Infinity;
    const market = Math.min(Math.max(providerMarket, observedMonthly), upper);
    const already = observed >= MIN_REACH_IMPRESSIONS ? observedMonthly * currentCtr : 0;
    const reachable = Math.max(0, market * targetCtr - already);
    limitations.length = 0;
    limitations.push(
      volume != null && volume > 0
        ? `the market is the provider's ${Math.round(volume)} searches/month, minus the clicks this page already earns`
        : "no provider volume, so our own observed impressions stand in for the market and the estimate is bounded by them"
    );
    limitations.push("a ranking change does not guarantee the CTR curve: snippets, AI answers and ads change it");
    if (input.currentPosition != null && input.currentPosition > 20) {
      limitations.push(
        `the site ranks ${Math.round(input.currentPosition)} today; reaching the target assumes it can outrank everything between`
      );
    }
    return {
      kind: "measured",
      basis: "first_party_impressions",
      incrementalClicksPerMonth: reachable,
      assumptions: {
        reachableImpressions: market,
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
    /**
     * No first-party impressions: the market is all we have, and the site earns none of
     * it yet. So the win is the market at the target CTR, net of whatever position it
     * already holds.
     *
     * `currentCtr` stays null when no position was observed rather than defaulting to
     * zero inside the formula — the difference between "ranks nowhere" and "position
     * unknown" is a fact the board has to be able to read, and `assumptions` is where
     * it is read from.
     */
    const currentCtr = input.observedCtr ?? ctrCurve(input.currentPosition ?? null);
    // Same formula as the measured branch, with the site earning nothing of this market:
    // it has no observed impressions for it. One formula, two evidence bases.
    const incrementalClicksPerMonth = Math.max(0, volume * targetCtr - (observed ?? 0) * (currentCtr ?? 0));
    limitations.push(
      "provider volume is the size of the market; the site is not currently shown for it",
      "the estimate assumes the site can reach and hold the target position for the whole market"
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

/** Below this many impressions the site is not competing for the query yet. */
export const MIN_REACH_IMPRESSIONS = 10;

/**
 * Whether this row's demand has been resolved enough to quote a number.
 *
 * Two independent routes resolve it, and they are routes rather than a score because
 * they answer different questions:
 *
 * - `observed` — Search Console showed this site for the query. The site is competing
 *   for it, however badly, so the market behind it is a fair target.
 * - `serp` — a SERP snapshot was bought for it. The site may have no impressions at all
 *   (a new site, a new page, a page that ranks below 100), but the competitive read
 *   tells us what winning costs, which is what D3 buys the snapshot for.
 *
 * Neither is a multiplier. Reach used to be one: `observedImpressions x CTR delta`
 * means a site's past visibility sets its future priority, so the same play scores 3 on
 * a new site and 40 on an established one. Missing evidence is not negative evidence,
 * and present evidence is not extra credit — it is permission to use the market number,
 * which is then the same number for both sites.
 *
 * Below `MIN_REACH_IMPRESSIONS` the site was technically shown but the read is too thin
 * to stand on, which is why that band keeps `hypothesis` until a SERP resolves it.
 */
export type DemandResolution = "observed" | "serp" | "page" | "unresolved";

export function resolveDemand(input: {
  observedImpressions?: number | null;
  hasSerp?: boolean;
  hasPage?: boolean;
}): DemandResolution {
  const observed = input.observedImpressions ?? 0;
  if (observed >= MIN_REACH_IMPRESSIONS) return "observed";
  if (input.hasSerp) return "serp";
  // D3's own wording: "a proposal with no page and no SERP is a hypothesis". A page that
  // already exists is a third route — it has its own Search Console record, and zero
  // impressions there is a measurement of a page that earns nothing, not an absence of
  // demand. It is still work on a real asset, so it is not a candidate.
  if (input.hasPage) return "page";
  return "unresolved";
}

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
