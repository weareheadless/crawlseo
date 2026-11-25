import { describe, expect, it } from "vitest";

import { computeScore, RELEVANCE_BY_SOURCE, type ScoreInputs } from "@/lib/funnel/scoring";
import { proposalScoreInputs } from "@/lib/research/opportunity-generation";
import type { TopicCluster } from "@/lib/research/topic-map";

/**
 * Where a business-value judgement came from must be recorded, and must be worth
 * what it is worth.
 *
 * Before this, `computeScore` damped every row without a `businessValueSource` to
 * 0.25, and `proposalScoreInputs` — the function that builds every generated
 * proposal's inputs — never set the field. Measured 2026-11-25: 1,654 of 1,965 rows
 * had no source and **all 102 open rows** were among them, so nearly the whole board
 * carried a penalty meant for rows with no business judgement behind them.
 *
 * On inmersionfreediving's "New Spanish article: apnea as a sport": 7 as stored, 22
 * with the source populated. The same work, decided by a missing field.
 */

function inputs(source: ScoreInputs["worth"]["businessValueSource"]): ScoreInputs {
  return {
    worth: {
      change: "New Spanish article: apnea as a sport",
      volume: 1300,
      intentFit: 0.35,
      readiness: "actionable",
      technical: false,
      windowDays: 28,
      measurement: "observed_baseline",
      targetPages: ["https://example.test/es/apnea-deporte"],
      benefitTrack: "organic_growth",
      intervention: "create_asset",
      volumeSource: "provider",
      businessValue: 0.55,
      businessValueSource: source,
      targetPosition: 10,
      currentPosition: null,
      observedImpressions: 0,
      unmeasured: false,
    },
    effort: { sizeFactor: 1, playTypeBase: 8 },
    freshness: 0.9,
    stability: 0.8,
    evidenceCompleteness: "both",
    winProbability: {
      authorityGap: null,
      pageStrength: null,
      rankDistance: null,
      playTypeFactor: 0.6,
      serpCompetition: null,
    },
    winProbabilitySource: {
      authorityGap: "assumed",
      pageStrength: "assumed",
      rankDistance: "assumed",
      playTypeFactor: "assumed",
      serpCompetition: "assumed",
    },
  } as unknown as ScoreInputs;
}

describe("a recorded business-value source is worth what it is worth", () => {
  it("scores the stored apnea row 22 once its source is known", () => {
    // The number this change is about. 7 was the penalty, not the judgement.
    expect(computeScore(inputs(undefined)).scoreValue).toBe(7);
    expect(computeScore(inputs("cluster")).scoreValue).toBe(22);
  });

  it("treats a cluster rating and a knowledge fact as equally grounded", () => {
    // Both are judgements about *this* business, derived from its own facts: the
    // owner said it, or the model read the site and rated the topic. Neither is a
    // guess about an unrelated market.
    expect(RELEVANCE_BY_SOURCE.knowledge).toBe(1);
    expect(RELEVANCE_BY_SOURCE.cluster).toBe(1);
    expect(computeScore(inputs("knowledge")).scoreValue).toBe(computeScore(inputs("cluster")).scoreValue);
  });

  it("still damps a weaker or absent source, as its own state", () => {
    // Damping exists so an off-brand traffic term cannot top the board. It must
    // survive this change — the point is that unknown stops standing in for
    // everything, not that the penalty disappears.
    expect(RELEVANCE_BY_SOURCE.unknown).toBeLessThan(RELEVANCE_BY_SOURCE.cluster);
    expect(computeScore(inputs(undefined)).scoreValue).toBeLessThan(computeScore(inputs("topic")).scoreValue);
    expect(computeScore(inputs("topic")).scoreValue).toBeLessThan(computeScore(inputs("cluster")).scoreValue);
  });
});

describe("the proposal generator records its relevance provenance", () => {
  const cluster = (relevance: TopicCluster["relevance"]): TopicCluster =>
    ({
      slug: "apnea-deporte",
      name: "Apnea as a sport",
      relevance,
      intent: "informational",
      coverage: "none",
      language: "es",
      rationale: "No page covers the sport itself.",
      gaps: [],
      metrics: { volume: 1300, impressions: 0, clicks: 0, position: null, windowDays: 28, difficulty: null },
      market: { scope: "international", places: [] },
    }) as unknown as TopicCluster;

  const proposal = {
    lane: "content_business",
    kind: "article",
    title: "New Spanish article: apnea as a sport",
    summary: "No page covers apnea as a sport.",
    action: "Write the article.",
    target: { url: null, newAsset: "/es/apnea-deporte", section: null },
    effort: "medium",
    confidence: "medium",
    topicSlug: "apnea-deporte",
  } as never;

  it("says `cluster` when the topic carried a rating", () => {
    const built = proposalScoreInputs(proposal, cluster("high"));
    expect(built.worth.businessValueSource).toBe("cluster");
  });

  it("says `unknown` when there is no topic behind the proposal", () => {
    const built = proposalScoreInputs(proposal, null);
    expect(built.worth.businessValueSource).toBe("unknown");
  });
});
