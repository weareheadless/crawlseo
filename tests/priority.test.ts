import { describe, expect, it } from "vitest";

import {
  bandFor,
  comparePriority,
  foundationsGate,
  intentFitFor,
  proposalPriority,
  type PriorityInput,
} from "@/lib/research/priority";
import type { TopicCluster, TopicMap } from "@/lib/research/topic-map";

function cluster(overrides: Partial<TopicCluster> = {}): TopicCluster {
  return {
    slug: "luminaires",
    name: "Luminaires",
    kind: "market",
    topicSummary: "",
    intent: "commercial",
    relevance: "high",
    rationale: "",
    actionHint: "",
    marketScope: { scope: "international", markets: [], source: "offer" },
    confidence: 0.7,
    metrics: {
      queries: 1,
      impressions: 1_000,
      clicks: 20,
      volume: 500,
      volumeSum: 500,
      difficulty: null,
      position: 8,
      aeoQuestions: 0,
      aeoCited: 0,
    },
    queries: [],
    excludedQueries: [],
    pages: [],
    coverage: "strong",
    visibility: "proven",
    coverageFacts: { page: true, ranks: true, converts: true },
    language: "en",
    contextOnly: { queries: 0, impressions: 0, volume: 0, examples: [] },
    reviewFlags: [],
    gaps: [],
    ...overrides,
  };
}

function mapWith(clusters: TopicCluster[]): TopicMap {
  return { locale: { language: "en", country: null }, clusters } as unknown as TopicMap;
}

function proposal(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return { lane: "content_business", kind: "update", effort: "medium", confidence: "medium", ...overrides };
}

describe("priority bands", () => {
  it("maps a measured position to a declared band", () => {
    expect(bandFor(2)).toBe("top3");
    expect(bandFor(8)).toBe("page1");
    expect(bandFor(15)).toBe("page2");
    expect(bandFor(42)).toBe("deep");
    expect(bandFor(null)).toBe("unranked");
  });

  it("discounts informational intent", () => {
    expect(intentFitFor("commercial")).toBe(1);
    expect(intentFitFor("transactional")).toBe(1);
    expect(intentFitFor("mixed")).toBe(0.7);
    expect(intentFitFor("informational")).toBe(0.35);
  });
});

describe("proposal priority", () => {
  const gateOff = { needed: false };
  const gateOn = { needed: true };

  it("scores measured impressions at the measured band, discounted by intent", () => {
    // 1,000 impressions × 4% at position 8 × commercial intent. Market volume
    // is context, not a multiplier.
    const priority = proposalPriority(proposal(), cluster(), gateOff);
    expect(priority.score).toBe(40);
    expect(priority.reason).toContain("1000 impressions in the window");
    expect(priority.reason).toContain("500 monthly market demand");
    expect(priority.band).toBe("page1");
    expect(priority.track).toBe("money");
    expect(priority.hold).toBe(false);
  });

  it("does not let market volume change the score", () => {
    const small = proposalPriority(proposal(), cluster(), gateOff);
    const huge = proposalPriority(
      proposal(),
      cluster({ metrics: { ...cluster().metrics, volume: 534_380 } }),
      gateOff
    );
    expect(huge.score).toBe(small.score);
    expect(huge.reason).toContain("534380 monthly market demand");
  });

  it("does not turn a big market into a score without measured reach", () => {
    const priority = proposalPriority(
      proposal(),
      cluster({ metrics: { ...cluster().metrics, impressions: 6, clicks: 0, volume: 534_380, position: 74 } }),
      gateOff
    );
    expect(priority.score).toBeNull();
    expect(priority.reason).toMatch(/below the 100 reach threshold/);
  });

  it("holds content when the site is invisible", () => {
    const priority = proposalPriority(proposal(), cluster(), gateOn);
    expect(priority.hold).toBe(true);
    const foundation = proposalPriority(proposal({ lane: "technical", kind: "technical" }), null, gateOn);
    expect(foundation.hold).toBe(false);
    expect(foundation.track).toBe("foundation");
  });

  it("orders foundations first only when the site is invisible", () => {
    const content = { proposal: proposal(), priority: proposalPriority(proposal(), cluster(), gateOn) };
    const technical = {
      proposal: proposal({ lane: "technical", kind: "technical" }),
      priority: proposalPriority(proposal({ lane: "technical", kind: "technical" }), null, gateOn),
    };
    expect(comparePriority(technical, content, gateOn)).toBeLessThan(0);
    expect(comparePriority(content, technical, gateOff)).toBeLessThan(0);
  });
});

describe("foundations gate", () => {
  it("opens when the site has too little reach", () => {
    const gate = foundationsGate(mapWith([cluster({ metrics: { ...cluster().metrics, impressions: 30, clicks: 0 } })]));
    expect(gate.needed).toBe(true);
    expect(gate.reason).toMatch(/Foundations first/);
  });

  it("closes when the site earns clicks", () => {
    const gate = foundationsGate(mapWith([cluster()]));
    expect(gate.needed).toBe(false);
    expect(gate.reason).toMatch(/content can be ranked by expected clicks/);
  });

  it("uses the site's own window totals, not the sum of topic memberships", () => {
    // Topic memberships overlap and miss queries, so their sum is a lower
    // bound. The gate must read the site totals the map now stores.
    const map = {
      ...mapWith([cluster({ metrics: { ...cluster().metrics, impressions: 0, clicks: 0 } })]),
      site: { impressions: 4_000, clicks: 60 },
    } as unknown as TopicMap;
    const gate = foundationsGate(map);
    expect(gate.needed).toBe(false);
  });
});
