import { describe, expect, it } from "vitest";

import { assessImpact, resolveDemand, MIN_REACH_IMPRESSIONS } from "@/lib/funnel/impact";
import {
  ASSUMED_WIN_PROBABILITY_CEILING,
  CLICKS_PER_HOUR_AT_CEILING,
  computeScore,
  type ScoreInputs,
} from "@/lib/funnel/scoring";

/**
 * Priority is a **rate**: clicks the work could win, per hour of work.
 *
 * ## Why this replaces a return
 *
 * The score used to be a return — `observed x CTR delta` — so it measured how visible a
 * site already is. Holding the play constant and varying only the site's existing reach:
 *
 * ```
 * 76 observed impressions   -> score  3
 * 7,600 observed impressions -> score 40
 * ```
 *
 * Same work, ranked by site size. For a site whose goal is growth that is backwards: the
 * marginal hour is worth most where there is the most room. So the numerator became the
 * *market* the query represents, and existing reach stopped being a multiplier.
 *
 * ## Why evidence gates it rather than scaling it
 *
 * A market number is only quotable when something resolves the demand read: Search Console
 * showed us the query, or a $0.004 SERP was bought so we know what winning costs. Those
 * are routes, not scores. Missing evidence is not negative evidence (a new site is not
 * penalised for having no history) and present evidence is not extra credit (an established
 * site is not rewarded for already being big). Both sites get the same market, and the
 * fight — not the history — decides the order.
 */

function play(over: {
  volume?: number | null;
  observedImpressions?: number | null;
  currentPosition?: number | null;
  targetPosition?: number | null;
  hasSerp?: boolean;
  effortHours?: number;
  win?: number;
} = {}): ScoreInputs {
  const win = over.win ?? 0.6;
  return {
    worth: {
      change: "Rank the person record for the head term",
      volume: over.volume ?? 135_390,
      intentFit: 0.6,
      readiness: "actionable",
      technical: false,
      windowDays: 28,
      measurement: "observed_baseline",
      targetPages: ["https://example.test/alex-karp"],
      benefitTrack: "organic_growth",
      intervention: "update_page",
      volumeSource: "provider",
      businessValue: 0.85,
      businessValueSource: "cluster",
      targetPosition: over.targetPosition ?? 10,
      currentPosition: over.currentPosition ?? 68,
      observedImpressions: over.observedImpressions ?? 76,
      hasSerp: over.hasSerp ?? false,
      unmeasured: false,
    },
    effort: { sizeFactor: 1, playTypeBase: over.effortHours ?? 4 },
    freshness: 0.9,
    stability: 0.8,
    evidenceCompleteness: "both",
    winProbability: {
      rankDistance: win,
      authorityGap: win,
      pageStrength: win,
      serpCompetition: win,
      playTypeFactor: 0.6,
    },
    winProbabilitySource: {
      rankDistance: "measured",
      authorityGap: "measured",
      pageStrength: "measured",
      serpCompetition: "measured",
      playTypeFactor: "assumed",
    },
  } as unknown as ScoreInputs;
}

describe("the market sizes the win, not our current visibility", () => {
  it("sizes a deep-ranking page from the market, not from its handful of impressions", () => {
    // alaguillotine, 'alex karp height': position 68, 76 impressions, 135,390/month market.
    // The old formula credited 2.85 clicks because 76 impressions x a CTR delta is all it
    // could see, which made the site's best striking-distance work a 3-point row.
    const assessed = assessImpact({
      volume: 135_390,
      volumeSource: "provider",
      observedImpressions: 76,
      currentPosition: 68,
      targetPosition: 10,
      windowDays: 28,
    });
    expect(assessed.kind).toBe("measured");
    // At 4% for the top ten, ranking 10th is worth thousands, not two.
    expect(assessed.incrementalClicksPerMonth).toBeGreaterThan(1_000);
    // And it says the market is what it sized, so the number is auditable.
    expect(assessed.assumptions.reachableImpressions).toBe(135_390);
  });

  it("does not reward a site for already being visible", () => {
    // The regression this replaces: more impressions meant a higher score for identical
    // work, because reach was the multiplier.
    const small = computeScore(play({ observedImpressions: 76 }));
    const large = computeScore(play({ observedImpressions: 7_600 }));
    expect(Math.abs(large.scoreValue - small.scoreValue)).toBeLessThanOrEqual(3);
  });

  it("ranks two sites doing the same work by the fight, not the site's history", () => {
    const easyFight = computeScore(play({ win: 0.9 }));
    const hardFight = computeScore(play({ win: 0.2 }));
    expect(easyFight.scoreValue).toBeGreaterThan(hardFight.scoreValue);
  });
});

describe("priority is a rate, so effort divides", () => {
  it("prefers the same return for less work", () => {
    const quick = computeScore(play({ effortHours: 1 }));
    const slow = computeScore(play({ effortHours: 16 }));
    expect(quick.scoreValue).toBeGreaterThan(slow.scoreValue);
  });

  it("reaches the declared ceiling at the declared rate, and stops there", () => {
    // A 40-hour project earning 8,000 clicks/month is 200 clicks/hour. The scale is
    // anchored so that is 100, and nothing exceeds it — a bigger number is a business
    // change for a person to judge, not a content edit to sort.
    const huge = computeScore(play({ volume: 20_000_000, observedImpressions: 5_000, effortHours: 40, win: 1 }));
    expect(huge.impact.incrementalClicksPerMonth! / 40).toBeGreaterThan(CLICKS_PER_HOUR_AT_CEILING);
    expect(huge.scoreValue).toBeLessThanOrEqual(ASSUMED_WIN_PROBABILITY_CEILING * 2.5);
  });
});

describe("evidence gates the number instead of scaling it", () => {
  it("resolves demand when the site was observed, or a SERP was bought", () => {
    expect(resolveDemand({ observedImpressions: MIN_REACH_IMPRESSIONS })).toBe("observed");
    expect(resolveDemand({ observedImpressions: 0, hasSerp: true })).toBe("serp");
    expect(resolveDemand({ observedImpressions: 0, hasSerp: false })).toBe("unresolved");
  });

  it("lets a bought SERP size a market the site has never been shown for", () => {
    // The whole point of D3's $0.004: a new site or a new page has no impressions, and
    // without the snapshot it could never size anything.
    const withSerp = assessImpact({
      volume: 4_800,
      volumeSource: "provider",
      observedImpressions: 0,
      currentPosition: null,
      targetPosition: 3,
      windowDays: 28,
      hasSerp: true,
    });
    expect(withSerp.kind).toBe("estimated");
    expect(withSerp.incrementalClicksPerMonth).toBeGreaterThan(0);
  });

  it("refuses to size a handful of impressions without a SERP", () => {
    // 900 searches a month against 5 impressions is a phrase the site does not compete for
    // yet, and measurement does not make reach exist.
    const unresolved = assessImpact({
      volume: 900,
      volumeSource: "provider",
      observedImpressions: 5,
      currentPosition: 12,
      targetPosition: 3,
      windowDays: 28,
    });
    expect(unresolved.kind).toBe("hypothesis");
    expect(unresolved.incrementalClicksPerMonth).toBeNull();
  });
});

describe("an implausible market cannot contradict our own measurement", () => {
  it("bounds a top-ranking page's market by what its impressions could support", () => {
    // Ranked 4th with 12 impressions cannot coexist with a 74,000/month market: at 4th the
    // site is shown for nearly every search. Without the bound this was credited 11,099
    // clicks/month.
    const assessed = assessImpact({
      volume: 74_000,
      volumeSource: "provider",
      observedImpressions: 12,
      observedCtr: 0.08,
      currentPosition: 4,
      targetPosition: 3,
      windowDays: 28,
    });
    expect(assessed.incrementalClicksPerMonth!).toBeLessThan(10);
  });

  it("keeps the market for a deep-ranking page, where impressions reveal nothing", () => {
    // The asymmetry that matters: at position 68 a small impression count is expected and
    // says nothing about market size, so the provider's figure must stand.
    const assessed = assessImpact({
      volume: 135_390,
      volumeSource: "provider",
      observedImpressions: 76,
      currentPosition: 68,
      targetPosition: 10,
      windowDays: 28,
    });
    expect(assessed.assumptions.reachableImpressions).toBe(135_390);
  });

  it("never lets the market fall below what the site already reaches", () => {
    // A long-tail cluster: 1,350 impressions against a 470 provider volume. Taking the
    // volume as the market made the win negative and scored real work at zero.
    const assessed = assessImpact({
      volume: 470,
      volumeSource: "provider",
      observedImpressions: 1_350,
      currentPosition: 41,
      targetPosition: 10,
      windowDays: 28,
    });
    expect(assessed.incrementalClicksPerMonth!).toBeGreaterThan(0);
  });
});

describe("unknown demand does not outrank sized work", () => {
  it("keeps an unsized row below a row with a real estimate", () => {
    // The band paid 21 for "we do not know" while sized rows scored 5. Missing evidence is
    // placed last by class ordering; it must not also win on the number.
    const unsized = computeScore({
      ...play({ volume: 0, observedImpressions: 0 }),
      worth: {
        ...play().worth,
        volume: null,
        volumeSource: "unknown",
        measurement: "unquantified",
        observedImpressions: 0,
      },
    } as unknown as ScoreInputs);
    const sized = computeScore(play());
    expect(unsized.impact.incrementalClicksPerMonth).toBeNull();
    expect(unsized.scoreValue).toBeLessThan(sized.scoreValue);
  });
});
