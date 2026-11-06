import { describe, expect, it } from "vitest";

import { buildClusterEvidenceIds } from "@/lib/research/opportunity-evidence";
import { evidenceKindLabel } from "@/lib/funnel/labels";
import type { TopicCluster } from "@/lib/research/topic-map";

function cluster(overrides: Partial<TopicCluster> = {}): TopicCluster {
  return {
    slug: "luminaires",
    name: "Luminaires",
    topicSummary: "",
    intent: "commercial",
    relevance: "high",
    rationale: "",
    actionHint: "",
    marketScope: { scope: "international", markets: ["France"], source: "offer" },
    confidence: 0.8,
    metrics: { queries: 2, impressions: 100, clicks: 1, volume: 200, volumeSum: 200, difficulty: null, position: 10, aeoQuestions: 0, aeoCited: 0 },
    excludedQueries: [],
    queries: [
      { query: "luminaire artisanal", impressions: 60, clicks: 0, position: 40, volume: 120, difficulty: null, observedAt: new Date() },
      { query: "plafonnier artisanal", impressions: 40, clicks: 0, position: 30, volume: 80, difficulty: null, observedAt: new Date() },
    ],
    pages: [],
    coverage: "strong",
    visibility: "proven",
    gaps: [],
    ...overrides,
  };
}

describe("proposal evidence selection", () => {
  it("prefers actual GSC, keyword-metric and SERP evidence over cluster membership", () => {
    const rows = [
      { id: "rank-1", kind: "keyword_rank", dimensions: { query: "luminaire artisanal", windowRole: "current" }, metrics: { "first_party:impressions": { value: 60 } }, observedAt: new Date("2026-11-03") },
      { id: "rank-2", kind: "keyword_rank", dimensions: { query: "plafonnier artisanal", windowRole: "current" }, metrics: { "first_party:impressions": { value: 40 } }, observedAt: new Date("2026-11-03") },
      { id: "metric-1", kind: "keyword_metrics", dimensions: { query: "luminaire artisanal" }, metrics: { "provider:volume": { value: 120 } }, observedAt: new Date("2026-11-03") },
      { id: "serp-1", kind: "serp_snapshot", dimensions: { query: "luminaire artisanal" }, metrics: { "provider:organicResults": { value: 10 } }, observedAt: new Date("2026-11-03") },
      { id: "membership-1", kind: "keyword_universe_membership", dimensions: { cluster: "luminaires", query: "luminaire artisanal" }, metrics: {}, observedAt: new Date("2026-11-03") },
    ];
    const ids = buildClusterEvidenceIds([cluster()], rows).get("luminaires") ?? [];
    expect(ids).toContain("rank-1");
    expect(ids).toContain("metric-1");
    expect(ids).toContain("serp-1");
    expect(ids).not.toContain("membership-1");
  });

  it("falls back to membership when no query evidence exists", () => {
    const rows = [
      { id: "membership-1", kind: "keyword_universe_membership", dimensions: { cluster: "luminaires", query: "luminaire artisanal" }, metrics: {}, observedAt: new Date("2026-11-03") },
    ];
    expect(buildClusterEvidenceIds([cluster()], rows).get("luminaires")).toEqual(["membership-1"]);
  });

  it("labels evidence in the board's language", () => {
    expect(evidenceKindLabel("keyword_rank")).toBe("Search Console query");
    expect(evidenceKindLabel("keyword_metrics")).toBe("Keyword metrics");
    expect(evidenceKindLabel("serp_snapshot")).toBe("SERP snapshot");
    expect(evidenceKindLabel("ai_visibility_observation")).toBe("AI visibility");
  });
});
