import { describe, expect, it } from "vitest";

import { reconcileScore } from "@/lib/research/score-reconciliation";
import type { TopicCluster } from "@/lib/research/topic-map";

/**
 * The board sorts by `Opportunity.scoreValue`; the priority logic that knows
 * about a reach gate and a foundations hold only ever renders a markdown report.
 * These tests pin the reporting of that divergence, not a change to it: the
 * point is that a row can say "the number you are sorting by is not measuring
 * demand" instead of the disagreement living in a review thread.
 */

function cluster(overrides: Partial<TopicCluster["metrics"]> = {}): TopicCluster {
  return {
    slug: "torre-25",
    name: "Torre 25",
    kind: "market",
    topicSummary: "",
    intent: "transactional",
    relevance: "high",
    rationale: "",
    actionHint: "",
    marketScope: { scope: "local", markets: [], source: "offer" },
    confidence: 0.5,
    metrics: {
      queries: 1,
      impressions: 1,
      clicks: 0,
      volume: 1600,
      volumeSum: 1600,
      difficulty: null,
      position: 11,
      aeoQuestions: 0,
      aeoCited: 0,
      ...overrides,
    },
    queries: [],
    excludedQueries: [],
    pages: [],
    coverage: "strong",
    visibility: "unproven",
    contextOnly: { queries: 0, impressions: 0, volume: null, examples: [] },
    reviewFlags: [],
    gaps: [],
  } as never;
}

describe("score reconciliation", () => {
  it("flags a row the board scores but whose demand is not reachable yet", () => {
    // 1 impression is far below the 100-impression reach gate, so there is no
    // click estimate — yet the row carries a stored score of 20.
    const result = reconcileScore({
      stored: 20,
      proposal: { lane: "content_business", kind: "update", title: "Push Torre 25" },
      cluster: cluster({ impressions: 1 }),
    });
    expect(result.priority?.score).toBeNull();
    expect(result.disagrees).toBe(true);
    expect(result.note).toContain("not reachable yet");
  });

  it("agrees when both can size the work", () => {
    const result = reconcileScore({
      stored: 40,
      proposal: { lane: "content_business", kind: "update", title: "Push Torre 25" },
      cluster: cluster({ impressions: 4000, position: 11 }),
    });
    expect(result.priority?.score).not.toBeNull();
    expect(result.disagrees).toBe(false);
    expect(result.note).toContain("position");
  });

  it("flags a row that could be sized but carries no stored score", () => {
    const result = reconcileScore({
      stored: 0,
      proposal: { lane: "content_business", kind: "update", title: "Push Torre 25" },
      cluster: cluster({ impressions: 4000, position: 11 }),
    });
    expect(result.disagrees).toBe(true);
    expect(result.note).toContain("not measuring demand");
  });

  it("treats a technical proposal as a foundation, not a click estimate", () => {
    const result = reconcileScore({
      stored: 12,
      proposal: { lane: "technical", kind: "technical", title: "Fix canonical" },
      cluster: null,
    });
    expect(result.priority?.track).toBe("foundation");
    expect(result.priority?.score).toBeNull();
    // A foundation row is allowed to hold a stored score: it is prioritised by
    // severity and reach, which the priority logic says explicitly.
    expect(result.disagrees).toBe(true);
    expect(result.note).toContain("not reachable");
  });
});
