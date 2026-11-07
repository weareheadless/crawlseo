import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chatJson: vi.fn() }));

vi.mock("@/lib/ai-seo/writer", () => ({
  contentWriterConfig: () => ({ model: "test-model", apiKey: "test", baseUrl: "https://example.invalid" }),
}));
vi.mock("@/lib/ai/chat", () => ({ chatJson: mocks.chatJson }));

import {
  draftClusterProposals,
  draftTimelyProposals,
  proposalIdentity,
  type DraftInput,
} from "@/lib/research/opportunity-drafting";
import type { TopicCluster, TopicMap } from "@/lib/research/topic-map";

const now = new Date("2026-11-05T12:00:00Z");

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
    confidence: 0.7,
    metrics: {
      queries: 1,
      impressions: 100,
      clicks: 1,
      volume: 200,
      volumeSum: 200,
      difficulty: null,
      position: 12,
      aeoQuestions: 0,
      aeoCited: 0,
    },
    queries: [
      {
        query: "luminaire artisanal",
        impressions: 100,
        clicks: 1,
        position: 12,
        volume: 200,
        difficulty: null,
        observedAt: now,
      },
    ],
    excludedQueries: [],
    pages: [],
    coverage: "partial",
    visibility: "proven",
    contextOnly: { queries: 0, impressions: 0, volume: 0, examples: [] },
    reviewFlags: [],
    gaps: [],
    ...overrides,
  };
}

function input(overrides: Partial<DraftInput> = {}): DraftInput {
  const map = {
    siteId: "site-1",
    projectId: "proj-1",
    domain: "atelier-harmonie.example",
    month: "2026-11",
    generatedAt: now.toISOString(),
    locale: { language: "fr", country: "FR" },
    marketScope: { default: "local", offers: [] },
    business: {
      name: "Atelier",
      services: ["Restauration de siège"],
      location: "Saint-Pierre-en-Port, France",
      serviceArea: ["Normandie"],
      audience: null,
      differentiators: [],
    },
    clusters: [cluster()],
    unmapped: [],
    news: [],
    ai: { available: false, model: null, summary: null, review: null, priorityTopics: [], weakTopics: [], marketExclusions: 0, error: null },
    counts: { queries: 1, clusteredQueries: 1, unmappedQueries: 0, pages: 0, news: 0 },
  } as unknown as TopicMap;
  return {
    map,
    marketScope: { default: "local", offers: [] },
    evidenceByCluster: new Map([
      [
        "luminaires",
        [
          { id: "ev-1", kind: "keyword_rank", query: "luminaire artisanal", position: 12, impressions: 100, volume: null, url: "/lampes" },
          { id: "ev-2", kind: "serp_snapshot", query: "luminaire artisanal", position: null, impressions: null, volume: null, url: null },
        ],
      ],
    ]),
    aeoQuestions: [],
    news: [],
    knowledgeEvidenceIds: ["k1"],
    now,
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    summary: "One proposal.",
    proposals: [
      {
        lane: "content_business",
        kind: "update",
        title: "Enrichir le hub luminaires",
        summary: "The hub ranks but the subcategories are thin.",
        whyNow: "Demand is already measured.",
        topicSlug: "luminaires",
        target: { url: "/lampes", newAsset: false, section: "hub" },
        action: "Expand the hub.",
        expectedOutcome: "More impressions.",
        effort: "medium",
        confidence: "medium",
        confidenceReason: "GSC rows show demand on /lampes.",
        evidenceIds: ["ev-1"],
        expiresAt: null,
        ...overrides,
      },
    ],
  };
}

describe("cluster drafting", () => {
  it("keeps only evidence ids the catalogue supplied", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValue(
      draft({ evidenceIds: ["ev-1", "invented-id"] })
    );
    const result = await draftClusterProposals(input());
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].evidenceRefs).toContain("ev-1");
    expect(result.proposals[0].evidenceRefs).not.toContain("invented-id");
  });

  it("drops a proposal that cites no supplied evidence", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValue(draft({ evidenceIds: ["invented-id"] }));
    const result = await draftClusterProposals(input());
    expect(result.proposals).toHaveLength(0);
  });

  it("leaves confidence unrated when the model does not give one", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValue(draft({ confidence: undefined, confidenceReason: undefined }));
    const result = await draftClusterProposals(input());
    expect(result.proposals[0].confidence).toBeNull();
    expect(result.proposals[0].confidenceReason).toBeNull();
  });

  it("keeps a cluster proposal out of the timely lane without a news source", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValue(draft({ lane: "timely", expiresAt: "2027-02-05" }));
    const result = await draftClusterProposals(input());
    expect(result.proposals[0].lane).toBe("content_business");
    expect(result.proposals[0].expiresAt).toBeNull();
  });

  it("drafts every cluster, not the first N", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValue({ proposals: [] });
    const base = input();
    const clusters = Array.from({ length: 30 }, (_, index) => ({
      ...base.map.clusters[0],
      slug: `topic-${index}`,
      name: `Topic ${index}`,
    }));
    await draftClusterProposals({
      ...base,
      map: { ...base.map, clusters } as never,
      evidenceByCluster: new Map(clusters.map((cluster) => [cluster.slug, []])),
    });
    // 30 clusters / batch of 4 = 8 calls. A cap at 24 would stop at 6.
    expect(mocks.chatJson).toHaveBeenCalledTimes(8);
  });

  it("reports proposals a batch bound dropped instead of hiding them", async () => {
    mocks.chatJson.mockReset();
    const base = draft();
    mocks.chatJson.mockResolvedValue({
      summary: "Many.",
      proposals: Array.from({ length: 8 }, (_, index) => ({
        ...base.proposals[0],
        title: `Proposal ${index}`,
        evidenceIds: ["ev-1"],
      })),
    });
    const result = await draftClusterProposals(input());
    expect(result.proposals).toHaveLength(6);
    expect(result.truncations.join(" ")).toMatch(/2 proposals/);
  });

  it("rejects a new page whose path already exists on the site", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValue({
      summary: "Rentals hub.",
      proposals: [
        {
          lane: "content_business",
          kind: "cluster_hub",
          title: "Rentals hub",
          summary: "One page for rentals.",
          whyNow: "Rental queries are close to page one.",
          topicSlug: "luminaires",
          target: { url: "/apartments-for-rent-in-playa-del-carmen", newAsset: true, section: "hub" },
          action: "Create the page.",
          expectedOutcome: "Rank for rentals.",
          effort: "small",
          confidence: "low",
          confidenceReason: "Thin demand.",
          evidenceIds: ["ev-1"],
          expiresAt: null,
        },
      ],
    });
    const result = await draftClusterProposals(
      input({ existingPaths: ["/apartments-for-rent-in-playa-del-carmen"] })
    );
    expect(result.proposals).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/already exists/);
  });

  it("rejects a proposal for a cluster that was not in the batch", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValue(draft({ topicSlug: "unknown-cluster" }));
    const result = await draftClusterProposals(input());
    expect(result.proposals).toHaveLength(0);
  });

  it("reports a batch failure instead of inventing proposals", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => {
      throw new Error("provider down");
    });
    const result = await draftClusterProposals(input());
    expect(result.proposals).toHaveLength(0);
    expect(result.errors[0]).toContain("provider down");
  });

  it("gives a re-worded proposal the same identity", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValueOnce(draft({ title: "Enrichir le hub" }));
    const first = await draftClusterProposals(input());
    mocks.chatJson.mockResolvedValueOnce(draft({ title: "Réécrire le hub luminaires" }));
    const second = await draftClusterProposals(input());
    expect(proposalIdentity(first.proposals[0])).toBe(proposalIdentity(second.proposals[0]));
  });
});

describe("timely drafting", () => {
  it("does not call the model when no story is inside the 21-day window", async () => {
    mocks.chatJson.mockReset();
    const result = await draftTimelyProposals(
      input({
        news: [
          {
            id: "n1",
            title: "Old story",
            url: "https://news.example/old",
            publishedAt: new Date(now.getTime() - 25 * 86_400_000).toISOString(),
            excerpt: null,
          },
        ],
      })
    );
    expect(mocks.chatJson).not.toHaveBeenCalled();
    expect(result.proposals).toHaveLength(0);
    expect(result.errors[0]).toMatch(/21 days/);
  });

  it("attaches the news source and an expiry to a timely proposal", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValue({
      summary: "A local story is current.",
      proposals: [
        {
          lane: "timely",
          kind: "article",
          title: "Réagir à la presse locale",
          summary: "Local press.",
          whyNow: "Published 2026-11-01.",
          topicSlug: "luminaires",
          target: { url: "/blog", newAsset: true, section: "news" },
          action: "Write a dated note.",
          expectedOutcome: "A dated story.",
          effort: "small",
          confidence: "low",
          confidenceReason: "Single local story.",
          evidenceIds: ["ev-1"],
          expiresAt: null,
          sourceUrl: "https://news.example/fresh",
        },
      ],
    });
    const result = await draftTimelyProposals(
      input({
        news: [
          {
            id: "n1",
            title: "Fresh story",
            url: "https://news.example/fresh",
            publishedAt: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
            excerpt: null,
          },
        ],
      })
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].sources[0].url).toBe("https://news.example/fresh");
    expect(Date.parse(result.proposals[0].expiresAt ?? "")).toBeGreaterThan(now.getTime());
  });
});

describe("taxonomy review guard", () => {
  it("does not draft a topic flagged with no need word", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockResolvedValue({ proposals: [] });
    const base = input();
    const flagged = {
      ...base.map,
      clusters: [{ ...base.map.clusters[0], reviewFlags: ["no-need-word"] }],
    };
    const result = await draftClusterProposals({ ...base, map: flagged });
    expect(result.proposals).toHaveLength(0);
    expect(mocks.chatJson).not.toHaveBeenCalled();
  });
});
