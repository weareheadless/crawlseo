import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chatJson: vi.fn() }));

vi.mock("@/lib/ai-seo/writer", () => ({
  contentWriterConfig: () => ({ model: "test-model", apiKey: "test", baseUrl: "https://example.invalid" }),
}));
vi.mock("@/lib/ai/chat", () => ({ chatJson: mocks.chatJson }));

import {
  loadTopicTaxonomy,
  parseTopicTaxonomy,
  proposeTopicTaxonomy,
  saveTopicTaxonomy,
  validateTopic,
  type TopicTaxonomyInput,
} from "@/lib/research/topic-taxonomy";

function topic(overrides: Record<string, unknown> = {}) {
  return {
    slug: "tulum-condos",
    name: "Tulum condos",
    intent: "commercial",
    relevance: "high",
    coverageKind: "product",
    offerKey: "Condos",
    rationale: "Buyers search Tulum condos directly.",
    requireAny: ["tulum", "condo"],
    terms: ["tulum", "condo", "condos"],
    strongTerms: ["condo"],
    pageTerms: ["tulum", "condo"],
    coverageRequireAny: ["condo"],
    actionHint: "Check the listing pages.",
    ...overrides,
  };
}

function input(overrides: Partial<TopicTaxonomyInput> = {}): TopicTaxonomyInput {
  return {
    domain: "example.com",
    language: "en",
    country: "MX",
    business: {
      name: "Example Realty",
      services: ["Condos", "Villas"],
      location: "Tulum",
      serviceArea: ["Riviera Maya"],
      audience: null,
      differentiators: [],
      concerns: [],
    },
    marketScope: { default: "local", offers: [{ offer: "Condos", scope: "local" }] },
    queries: [
      { query: "tulum condos for sale", impressions: 40, volume: 300 },
      { query: "tulum condos", impressions: 25, volume: 200 },
    ],
    pagePaths: ["/tulum-condos"],
    pages: [{ path: "/tulum-condos", title: "Tulum condos", h1: "Tulum condos", wordCount: 800 }],
    ...overrides,
  };
}

describe("taxonomy validation", () => {
  it("accepts a topic that can match a query", () => {
    const { topic: parsed, reason } = validateTopic(topic());
    expect(reason).toBeNull();
    expect(parsed?.slug).toBe("tulum-condos");
    expect(parsed?.requireAny).toEqual(["tulum", "condo"]);
  });

  it("rejects a topic with no matching terms", () => {
    const { topic: parsed, reason } = validateTopic(topic({ terms: [] }));
    expect(parsed).toBeNull();
    expect(reason).toMatch(/no matching terms/);
  });

  it("rejects invalid enums and missing names", () => {
    expect(validateTopic(topic({ intent: "buy" })).reason).toMatch(/invalid intent/);
    expect(validateTopic(topic({ coverageKind: "landing" })).reason).toMatch(/invalid coverageKind/);
    expect(validateTopic(topic({ name: "" })).reason).toMatch(/missing name/);
  });

  it("defaults requireAny and pageTerms to the matching terms", () => {
    const { topic: parsed } = validateTopic(topic({ requireAny: [], pageTerms: [] }));
    expect(parsed?.requireAny).toEqual(["tulum", "condo", "condos"]);
    expect(parsed?.pageTerms).toEqual(["tulum", "condo", "condos"]);
  });

  it("drops duplicates and invalid topics from a proposal", () => {
    const { taxonomy, rejected } = parseTopicTaxonomy(
      {
        topics: [topic(), topic(), topic({ slug: "broken", terms: [] })],
        pageTypeRules: [{ type: "product", pattern: "/tulum-condos" }, { type: "nonsense", pattern: "/x" }],
        excludePaths: ["/terms"],
        newsQueries: ["tulum real estate news"],
        summary: "Two topics.",
      },
      { proposedBy: "ai", model: "test-model" }
    );
    expect(taxonomy.topics).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(taxonomy.pageTypeRules).toEqual([{ type: "product", pattern: "/tulum-condos" }]);
    expect(taxonomy.excludePaths).toEqual(["/terms"]);
    expect(taxonomy.newsQueries).toEqual(["tulum real estate news"]);
  });
});

describe("taxonomy proposal", () => {
  const clusterId = (calls: unknown[]) => {
    const payload = JSON.parse(String((calls[0] as { user: string }).user)) as { clusters: Array<{ id: string }> };
    return payload.clusters[0].id;
  };

  it("derives membership terms from the cluster's own queries", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async (args: { user: string }) => {
      const payload = JSON.parse(args.user) as { clusters: Array<{ id: string }> };
      return {
        summary: "One topic.",
        clusters: [
          {
            id: payload.clusters[0].id,
            keep: true,
            name: "Tulum condos",
            intent: "commercial",
            relevance: "high",
            coverageKind: "product",
            offerKey: "Condos",
            rationale: "Buyers search Tulum condos directly.",
            actionHint: "Check the listing page.",
            preferredPages: ["/tulum-condos"],
          },
        ],
        pageTypeRules: [{ type: "product", pattern: "/tulum-condos" }],
        excludePaths: ["/terms"],
        newsQueries: ["tulum real estate news"],
      };
    });
    const result = await proposeTopicTaxonomy(input());
    expect(result.error).toBeNull();
    expect(result.taxonomy?.topics).toHaveLength(1);
    const topic = result.taxonomy!.topics[0];
    // The terms come from "tulum condos for sale", not from the model.
    expect(topic.terms).toContain("tulum");
    expect(topic.terms).toContain("condos");
    expect(topic.requireAny.length).toBeGreaterThan(0);
    expect(topic.preferredPages).toEqual(["/tulum-condos"]);
    expect(topic.offerKey).toBe("Condos");
    expect(result.taxonomy?.proposedBy).toBe("ai");
  });

  it("drops a cluster the review rejects", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async (args: { user: string }) => {
      const payload = JSON.parse(args.user) as { clusters: Array<{ id: string }> };
      return { summary: "Off business.", clusters: [{ id: payload.clusters[0].id, keep: false }] };
    });
    const result = await proposeTopicTaxonomy(input());
    expect(result.taxonomy).toBeNull();
    expect(result.error).toMatch(/kept no cluster/);
  });

  it("reports a provider failure", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => {
      throw new Error("provider down");
    });
    const result = await proposeTopicTaxonomy(input());
    expect(result.taxonomy).toBeNull();
    expect(result.error).toContain("provider down");
  });
});

describe("taxonomy storage", () => {
  it("merges into the site profile without dropping other constraints", async () => {
    const state = { constraints: { marketScope: { default: "local" } } as Record<string, unknown>, created: 0 };
    const db = {
      siteProfile: {
        findUnique: async () => ({ constraints: state.constraints }),
        update: async ({ data }: { data: { constraints: Record<string, unknown> } }) => {
          state.constraints = data.constraints;
          return {};
        },
        create: async () => {
          state.created += 1;
          return {};
        },
      },
    };
    const { taxonomy } = parseTopicTaxonomy({ topics: [topic()] }, { proposedBy: "human", model: null });
    await saveTopicTaxonomy(db as never, "site-1", taxonomy);
    expect(state.constraints.marketScope).toEqual({ default: "local" });
    expect((state.constraints.topicTaxonomy as { topics: unknown[] }).topics).toHaveLength(1);
    expect(state.created).toBe(0);
  });

  it("creates a profile when the site has none", async () => {
    let created = 0;
    const db = {
      siteProfile: {
        findUnique: async () => null,
        update: async () => ({}),
        create: async () => {
          created += 1;
          return {};
        },
      },
    };
    const { taxonomy } = parseTopicTaxonomy({ topics: [topic()] }, { proposedBy: "ai", model: "m" });
    await saveTopicTaxonomy(db as never, "site-1", taxonomy);
    expect(created).toBe(1);
  });

  it("returns null when the stored profile has no taxonomy", async () => {
    const db = { siteProfile: { findUnique: async () => ({ constraints: {} }) } };
    expect(await loadTopicTaxonomy(db as never, "site-1")).toBeNull();
  });
});
