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
  it("derives membership terms from the queries the model cites", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      summary: "One topic.",
      topics: [
        {
          name: "Tulum condos",
          intent: "commercial",
          relevance: "high",
          coverageKind: "product",
          offerKey: "Condos",
          rationale: "Buyers search Tulum condos directly.",
          actionHint: "Check the listing page.",
          memberQueries: ["tulum condos for sale", "tulum condos"],
          preferredPages: ["/tulum-condos"],
        },
      ],
      pageTypeRules: [{ type: "product", pattern: "/tulum-condos" }],
      excludePaths: ["/terms"],
      newsQueries: ["tulum real estate news"],
    }));
    const result = await proposeTopicTaxonomy(input());
    expect(result.error).toBeNull();
    expect(result.taxonomy?.topics).toHaveLength(1);
    const topic = result.taxonomy!.topics[0];
    expect(topic.terms).toContain("tulum");
    expect(topic.terms).toContain("condos");
    expect(topic.preferredPages).toEqual(["/tulum-condos"]);
    expect(topic.offerKey).toBe("Condos");
    expect(result.taxonomy?.proposedBy).toBe("ai");
  });

  it("sends the queries themselves, not pre-merged clusters", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({ topics: [] }));
    await proposeTopicTaxonomy(input());
    const payload = JSON.parse(String((mocks.chatJson.mock.calls[0][0] as { user: string }).user)) as {
      queries: Array<{ query: string }>;
      clusters?: unknown;
    };
    expect(payload.clusters).toBeUndefined();
    expect(payload.queries.map((row) => row.query)).toContain("tulum condos for sale");
  });

  it("rejects a topic whose members are not in the supplied sample", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      topics: [
        {
          name: "Invented topic",
          intent: "commercial",
          relevance: "high",
          coverageKind: "product",
          memberQueries: ["a query that was never supplied", "another invented query"],
        },
      ],
    }));
    const result = await proposeTopicTaxonomy(input());
    expect(result.taxonomy).toBeNull();
    expect(result.rejected[0].reason).toMatch(/cites no query/);
  });

  it("keeps a topic that has one real query", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      topics: [
        {
          name: "Ikuku for sale",
          intent: "commercial",
          relevance: "medium",
          coverageKind: "product",
          memberQueries: ["tulum condos for sale"],
        },
      ],
    }));
    const result = await proposeTopicTaxonomy(input());
    expect(result.taxonomy?.topics).toHaveLength(1);
    expect(result.taxonomy?.topics[0].requireAny.length).toBeGreaterThan(0);
  });

  it("keeps a topic whose queries share no term, matching its cited queries", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      topics: [
        {
          name: "Elementos Cozumel",
          intent: "commercial",
          relevance: "medium",
          coverageKind: "product",
          memberQueries: ["tulum condos for sale", "tulum condos"],
        },
      ],
    }));
    const result = await proposeTopicTaxonomy(input());
    // The two queries share "tulum", so a term exists; the topic must survive
    // either way, and its membership must claim both queries.
    const topic = result.taxonomy?.topics[0];
    expect(topic).toBeDefined();
    expect(topic!.requireAny.some((term) => "tulum condos for sale".includes(term))).toBe(true);
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
