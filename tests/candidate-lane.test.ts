import { describe, expect, it } from "vitest";

import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";
import { proposalScoreInputs } from "@/lib/research/opportunity-generation";
import type { TopicCluster } from "@/lib/research/topic-map";

/**
 * D3: a discovery proposal is a candidate until one SERP is bought.
 *
 * A proposal for a page that does not exist, on a topic the site has never been observed
 * for, has exactly one demand number behind it: provider volume. That is market size, not
 * reachable demand, and presenting it as expected clicks is how *a page that does not
 * exist* scored 38 on alaguillotine while *a page ranking 29th* scored 1.
 *
 * The rule: `expectedClicksPerMonth` is `null` for a candidate and the row is labelled as
 * one. One $0.004 SERP makes it `observed`, because after that the site has a real
 * competitive read — which is what `metrics.difficulty` records.
 */

function inputs(over: Partial<ScoreInputs["worth"]> = {}): ScoreInputs {
  return {
    worth: {
      change: "A hub behind the person records",
      volume: 16400,
      intentFit: 0.35,
      readiness: "actionable",
      technical: false,
      windowDays: 28,
      measurement: "observed_baseline",
      targetPages: [],
      benefitTrack: "organic_growth",
      intervention: "create_asset",
      volumeSource: "provider",
      businessValue: 0.85,
      businessValueSource: "cluster",
      targetPosition: 10,
      currentPosition: null,
      observedImpressions: 0,
      unmeasured: false,
      ...over,
    },
    effort: { sizeFactor: 1, playTypeBase: 8 },
    freshness: 0.9,
    stability: 0.8,
    evidenceCompleteness: "how",
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

describe("a candidate has no expected clicks, and says so", () => {
  it("reports null for a candidate even when the projection computed a number", () => {
    // The projection still computes an estimate internally — the impact assessment is
    // honest about what it did. What changes is what the row *claims*: a candidate
    // presents no expected return, so the number cannot be quoted as one.
    const candidate = computeScore(inputs({ demandResolution: "candidate" }));
    expect(candidate.expectedClicksPerMonth).toBeNull();
    expect(candidate.demandResolution).toBe("candidate");
  });

  it("reports the estimate once the demand is observed", () => {
    // A real position is needed for the CTR curve; without one there is no estimate to
    // report, which is a different (and correct) outcome.
    const observed = computeScore(inputs({ demandResolution: "observed", observedImpressions: 420, currentPosition: 14 }));
    expect(observed.expectedClicksPerMonth).not.toBeNull();
    expect(observed.expectedClicksPerMonth).toBeGreaterThan(0);
  });

  it("does not read a missing marker as observed", () => {
    // Rows written before D3 have no marker. Assuming they were measured would present a
    // legacy projection as a measurement, which is the defect rather than the fix.
    const legacy = computeScore(inputs());
    expect(legacy.demandResolution).toBe("unrecorded");
  });
});

describe("the generator marks a discovery proposal as a candidate", () => {
  const proposal = {
    lane: "content_business",
    kind: "article",
    title: "A hub behind the person records",
    summary: "No page covers this.",
    action: "Write it.",
    target: { url: null, newAsset: true, section: null },
    effort: "medium",
    confidence: "medium",
    topicSlug: "wealth-hub",
  } as never;

  function cluster(over: { impressions?: number; difficulty?: number | null }): TopicCluster {
    return {
      slug: "wealth-hub",
      name: "Wealth hub",
      relevance: "high",
      intent: "informational",
      coverage: "none",
      language: "en",
      rationale: "No page covers it.",
      gaps: [],
      metrics: {
        volume: 16400,
        impressions: over.impressions ?? 0,
        clicks: 0,
        position: null,
        windowDays: 28,
        difficulty: over.difficulty ?? null,
      },
      market: { scope: "international", places: [] },
    } as unknown as TopicCluster;
  }

  it("is a candidate when there is no page, no impressions and no bought SERP", () => {
    const built = proposalScoreInputs(proposal, cluster({}));
    expect((built.worth as { demandResolution?: string }).demandResolution).toBe("candidate");
  });

  it("stops being a candidate once a SERP has been bought", () => {
    // `difficulty` is only populated from a purchased snapshot. A topic with one has a
    // real competitive read, so it is no longer a hypothesis about the market.
    const built = proposalScoreInputs(proposal, cluster({ difficulty: 42 }));
    expect((built.worth as { demandResolution?: string }).demandResolution).toBe("observed");
  });

  it("stops being a candidate once the site has impressions for the topic", () => {
    const built = proposalScoreInputs(proposal, cluster({ impressions: 76 }));
    expect((built.worth as { demandResolution?: string }).demandResolution).toBe("observed");
  });

  it("is not a candidate when the proposal targets a page that exists", () => {
    const existing = {
      ...(proposal as Record<string, unknown>),
      target: { url: "https://example.test/alex-karp", newAsset: false, section: null },
    } as never;
    const built = proposalScoreInputs(existing, cluster({}));
    expect((built.worth as { demandResolution?: string }).demandResolution).toBe("observed");
  });
});
