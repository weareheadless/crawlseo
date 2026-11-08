import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chatJson: vi.fn() }));

vi.mock("@/lib/ai-seo/writer", () => ({
  contentWriterConfig: () => ({ model: "test-model", apiKey: "test", baseUrl: "https://example.invalid" }),
}));
vi.mock("@/lib/ai/chat", () => ({ chatJson: mocks.chatJson }));

import {
  brandTermMatches,
  isBrandTopic,
  loadTopicTaxonomy,
  parseTopicTaxonomy,
  proposeTopicTaxonomy,
  queryMatchesTopics,
  saveTopicTaxonomy,
  stabilizeTopicTaxonomy,
  validateTopic,
  type TopicDefinition,
  type TopicTaxonomyInput,
} from "@/lib/research/topic-taxonomy";

function topic(overrides: Record<string, unknown> = {}) {
  return {
    slug: "tulum-condos",
    name: "Tulum condos",
    kind: "market",
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
    const { topic: parsed, reason } = validateTopic(topic({ terms: [], requireAny: [], need: undefined }));
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
        topics: [topic(), topic(), topic({ slug: "broken", terms: [], requireAny: [], need: undefined })],
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
  it("stores the need terms the model proposes", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      summary: "One topic.",
      topics: [
        {
          name: "Tulum condos",
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Tulum"],
          localIntent: [],
          needTerms: ["tulum condos", "condos"],
          intent: "commercial",
          relevance: "high",
          coverageKind: "product",
          offerKey: "Condos",
          rationale: "Buyers search Tulum condos directly.",
          actionHint: "Check the listing page.",
          memberQueries: ["tulum condos for sale", "tulum condos"],
          ownerPages: ["/tulum-condos"],
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
    expect(topic.need?.terms).toEqual(["tulum condos", "condos"]);
    expect(topic.terms).toEqual(["tulum condos", "condos"]);
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

  it("sends the previous map's unmapped demand to the next proposal", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({ topics: [] }));
    await proposeTopicTaxonomy(input({
      previousUnmapped: [{ query: "lustre artisanal", impressions: 85, volume: null }],
    }));
    const payload = JSON.parse(String((mocks.chatJson.mock.calls[0][0] as { user: string }).user)) as {
      previousUnmapped: { count: number; sent: number; queries: Array<{ query: string }> } | null;
    };
    expect(payload.previousUnmapped?.count).toBe(1);
    expect(payload.previousUnmapped?.queries[0].query).toBe("lustre artisanal");
  });

  it("reports how many previous unmapped queries it did not send", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({ topics: [] }));
    const previousUnmapped = Array.from({ length: 250 }, (_, index) => ({
      query: `query ${index}`,
      impressions: 1,
      volume: null,
    }));
    await proposeTopicTaxonomy(input({ previousUnmapped }));
    const payload = JSON.parse(String((mocks.chatJson.mock.calls[0][0] as { user: string }).user)) as {
      previousUnmapped: { count: number; sent: number };
    };
    expect(payload.previousUnmapped.count).toBe(250);
    expect(payload.previousUnmapped.sent).toBe(200);
  });

  it("omits previous unmapped demand when there is none", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({ topics: [] }));
    await proposeTopicTaxonomy(input());
    const payload = JSON.parse(String((mocks.chatJson.mock.calls[0][0] as { user: string }).user)) as {
      previousUnmapped: unknown;
    };
    expect(payload.previousUnmapped).toBeNull();
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
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Tulum"],
          localIntent: [],
          needTerms: ["ikuku"],
          intent: "commercial",
          relevance: "medium",
          coverageKind: "product",
          memberQueries: ["ikuku tulum for sale"],
          ownerPages: ["/tulum-condos"],
        },
      ],
      pageTypeRules: [{ type: "product", pattern: "/tulum-condos" }],
    }));
    const result = await proposeTopicTaxonomy(input({
      queries: [
        { query: "ikuku tulum for sale", impressions: 3, volume: null },
        { query: "tulum condos for sale", impressions: 40, volume: 300 },
      ],
    }));
    expect(result.taxonomy?.topics).toHaveLength(1);
    expect(result.taxonomy?.topics[0].requireAny.length).toBeGreaterThan(0);
  });

  it("rejects a local topic whose cited queries name no place", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      topics: [
        {
          name: "Restauration de sièges en Normandie",
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Normandie"],
          localIntent: [],
          needTerms: ["restauration de sièges", "tapissier"],
          intent: "commercial",
          relevance: "high",
          coverageKind: "service",
          memberQueries: ["restauration de sièges", "tapissier"],
          ownerPages: ["/tapisserie-restauration"],
        },
      ],
    }));
    const result = await proposeTopicTaxonomy(input({
      queries: [
        { query: "restauration de sièges", impressions: 30, volume: 900 },
        { query: "tapissier", impressions: 10, volume: 200 },
      ],
      pages: [{ path: "/tapisserie-restauration", title: "Tapisserie", h1: "Tapisserie", wordCount: 600 }],
    }));
    // The evidence does not name the place the topic claims. The model must
    // widen the scope or cite queries that support it; the code does not
    // silently drop the place or the need.
    expect(result.taxonomy).toBeNull();
    expect(result.rejected.some((row) => /matches its own market and need/.test(row.reason))).toBe(true);
  });

  it("rejects an owner page that is not in the supplied inventory", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      topics: [
        {
          name: "Tulum condos",
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Tulum"],
          localIntent: [],
          needTerms: ["condos"],
          intent: "commercial",
          relevance: "high",
          coverageKind: "product",
          memberQueries: ["tulum condos for sale"],
          ownerPages: ["/invented-page"],
        },
      ],
    }));
    const result = await proposeTopicTaxonomy(input());
    expect(result.taxonomy).toBeNull();
    expect(result.rejected.some((row) => /not in the supplied inventory/.test(row.reason))).toBe(true);
  });

  it("sends the current taxonomy so a pass revises instead of re-rolling", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({ topics: [] }));
    await proposeTopicTaxonomy(input({
      currentTaxonomy: [
        {
          name: "Tulum condos",
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Tulum"],
          localIntent: [],
          needTerms: ["condos"],
          ownerPages: ["/tulum-condos"],
        },
      ],
    }));
    const payload = JSON.parse(String((mocks.chatJson.mock.calls[0][0] as { user: string }).user)) as {
      currentTaxonomy: Array<{ name: string }>;
    };
    expect(payload.currentTaxonomy[0].name).toBe("Tulum condos");
  });

  it("sends the job map to the proposal", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({ topics: [] }));
    await proposeTopicTaxonomy(input({
      jobs: [
        {
          slug: "buy-tulum",
          statement: "I want to buy a condo in Tulum",
          stage: "buy",
          language: "en",
          marketScope: "local",
          marketPlaces: ["Tulum"],
          businessFit: "serves",
          queries: ["tulum condos for sale"],
          page: "/tulum-condos",
        },
      ],
    }));
    const payload = JSON.parse(String((mocks.chatJson.mock.calls[0][0] as { user: string }).user)) as {
      jobs: Array<{ statement: string }>;
    };
    expect(payload.jobs[0].statement).toBe("I want to buy a condo in Tulum");
  });

  it("re-proposes when a served job has no owning topic", async () => {
    mocks.chatJson.mockReset();
    // The first proposal owns another market, not the served job's demand.
    mocks.chatJson.mockImplementationOnce(async () => ({
      topics: [
        {
          name: "Playa del Carmen villas",
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Playa del Carmen"],
          localIntent: [],
          needTerms: ["playa del carmen villas"],
          intent: "commercial",
          relevance: "high",
          coverageKind: "product",
          offerKey: "Villas",
          rationale: "Villa buyers search Playa directly.",
          actionHint: "Check the villa page.",
          memberQueries: ["playa del carmen villas"],
          ownerPages: ["/tulum-condos"],
        },
      ],
    }));
    mocks.chatJson.mockImplementationOnce(async () => ({
      topics: [
        {
          name: "Tulum condos",
          job: "buy-tulum-condo",
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Tulum"],
          localIntent: [],
          needTerms: ["tulum condos"],
          intent: "commercial",
          relevance: "high",
          coverageKind: "product",
          offerKey: "Condos",
          rationale: "Buyers search Tulum condos directly.",
          actionHint: "Check the listing page.",
          memberQueries: ["tulum condos for sale"],
          ownerPages: ["/tulum-condos"],
        },
      ],
    }));
    const result = await proposeTopicTaxonomy(input({
      queries: [
        { query: "tulum condos for sale", impressions: 40, volume: 300 },
        { query: "playa del carmen villas", impressions: 5, volume: 50 },
      ],
      jobs: [
        {
          slug: "buy-tulum-condo",
          statement: "I want to buy a condo in Tulum",
          stage: "buy",
          language: "en",
          marketScope: "local",
          marketPlaces: ["Tulum"],
          businessFit: "serves",
          queries: ["tulum condos for sale"],
          page: "/tulum-condos",
        },
      ],
    }));
    expect(mocks.chatJson).toHaveBeenCalledTimes(2);
    const correction = JSON.parse(String((mocks.chatJson.mock.calls[1][0] as { user: string }).user)) as {
      correction: { missingJobs: Array<{ slug: string }>; instruction: string };
    };
    expect(correction.correction.missingJobs[0].slug).toBe("buy-tulum-condo");
    expect(correction.correction.instruction).toMatch(/one topic is one job/i);
    expect(result.missingJobs).toHaveLength(0);
    expect(result.taxonomy?.topics.map((row) => row.slug)).toContain("tulum-condos");
  });

  it("accepts a job topic whose evidence is only a project name", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      topics: [
        {
          name: "Torre 25",
          job: "evaluate-torre-25",
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Playa del Carmen"],
          localIntent: [],
          needTerms: ["torre 25"],
          intent: "commercial",
          relevance: "high",
          coverageKind: "product",
          offerKey: "Condos",
          rationale: "Buyers evaluate this project before buying.",
          actionHint: "Check the project page.",
          memberQueries: ["torre 25"],
          ownerPages: ["/torre-25"],
        },
      ],
    }));
    const result = await proposeTopicTaxonomy(input({
      queries: [{ query: "torre 25", impressions: 1, volume: 90 }],
      pagePaths: ["/torre-25"],
      pages: [{ path: "/torre-25", title: "Torre 25", h1: "Torre 25", wordCount: 500 }],
      jobs: [
        {
          slug: "evaluate-torre-25",
          statement: "I want to evaluate Torre 25 before buying",
          stage: "research",
          language: "es",
          marketScope: "local",
          marketPlaces: ["Playa del Carmen"],
          businessFit: "serves",
          queries: ["torre 25"],
          page: "/torre-25",
        },
      ],
    }));
    expect(result.rejected).toHaveLength(0);
    expect(result.taxonomy?.topics[0].jobSlug).toBe("evaluate-torre-25");
    expect(result.missingJobs).toHaveLength(0);
  });

  it("does not derive need terms when the model omits them", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      topics: [
        {
          name: "Elementos Cozumel",
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Cozumel"],
          localIntent: [],
          intent: "commercial",
          relevance: "medium",
          coverageKind: "product",
          memberQueries: ["tulum condos for sale", "tulum condos"],
          ownerPages: ["/tulum-condos"],
        },
      ],
      pageTypeRules: [{ type: "product", pattern: "/tulum-condos" }],
    }));
    const result = await proposeTopicTaxonomy(input());
    // The need is the model's semantic choice. Without it the topic is a
    // contract rejection, not a topic whose terms are guessed from queries.
    expect(result.taxonomy).toBeNull();
    expect(result.rejected.some((row) => /no need terms/.test(row.reason))).toBe(true);
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

describe("taxonomy stabilization", () => {
  function definition(overrides: Record<string, unknown>): TopicDefinition {
    const { topic: parsed } = validateTopic(topic(overrides));
    if (!parsed) throw new Error("invalid fixture");
    return parsed;
  }

  const topics = [
    definition({
      slug: "brand",
      name: "Brand",
      coverageKind: "brand",
      requireAny: ["ocean vibes"],
      terms: ["ocean vibes", "oceanvibes", "freediving"],
      strongTerms: ["ocean vibes"],
      headTerms: ["freediving"],
      preferredPages: ["/"],
    }),
    definition({
      slug: "courses",
      name: "Courses",
      coverageKind: "service",
      requireAny: ["course"],
      terms: ["freediving", "course"],
      strongTerms: ["course"],
      preferredPages: ["/blog/course"],
    }),
    definition({
      slug: "tulum",
      name: "Tulum",
      coverageKind: "local",
      requireAny: ["tulum"],
      terms: ["freediving", "tulum"],
      strongTerms: ["tulum"],
      preferredPages: ["/blog/cenote"],
    }),
    definition({
      slug: "cenotes",
      name: "Cenotes",
      coverageKind: "local",
      requireAny: ["cenote", "freediving"],
      terms: ["freediving", "cenote"],
      strongTerms: ["cenote"],
      preferredPages: ["/blog/cenote"],
    }),
  ];
  const queries = [
    { query: "freediving", impressions: 0, volume: 12100 },
    { query: "freediving course", impressions: 0, volume: 1300 },
    { query: "freediving tulum", impressions: 0, volume: 30 },
    { query: "cenote freediving", impressions: 0, volume: 20 },
    { query: "ocean vibes", impressions: 2, volume: 1300 },
    { query: "oceanvibes", impressions: 2, volume: 1300 },
  ];

  it("merges two topics that share a specific owner, but not the homepage", () => {
    const result = stabilizeTopicTaxonomy({ topics, queries });
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0].page).toBe("/blog/cenote");
    expect(result.topics.map((entry) => entry.slug)).not.toContain("tulum");
    // Both the brand and the course topic point at pages, so nothing else merges.
    expect(result.topics.map((entry) => entry.slug)).toContain("brand");
    expect(result.topics.map((entry) => entry.slug)).toContain("courses");
  });

  it("reports the head term the model proposed and keeps it on its owner", () => {
    const result = stabilizeTopicTaxonomy({ topics, queries });
    const head = result.headTerms.find((entry) => entry.term === "freediving");
    expect(head?.owner).toBe("Brand");
    const brand = result.topics.find((entry) => entry.slug === "brand")!;
    expect(brand.headTerms).toContain("freediving");
  });

  it("does not invent a head term the taxonomy did not propose", () => {
    const result = stabilizeTopicTaxonomy({ topics, queries });
    expect(result.headTerms.map((entry) => entry.term)).not.toContain("course");
  });

  it("matches the site's own name even when the model split it in two", () => {
    const brand = definition({
      slug: "oceanicvibes-brand",
      name: "OceanicVibes brand",
      coverageKind: "brand",
      requireAny: ["ocean vibes", "oceanvibes", "ocean"],
      terms: ["ocean vibes", "oceanvibes", "freediving"],
      strongTerms: ["ocean vibes"],
      preferredPages: ["/"],
      exclusive: true,
    });
    const result = stabilizeTopicTaxonomy({
      topics: [brand],
      queries: [
        { query: "ocean vibes", impressions: 2, volume: 1300 },
        { query: "oceanvibes", impressions: 2, volume: 1300 },
      ],
      brandKey: "oceanicvibes",
    });
    const kept = result.topics[0];
    expect(kept.requireAny).toContain("oceanicvibes");
    expect(kept.requireAny).not.toContain("ocean");
    expect(queryMatchesTopics([kept], "Is OceanicVibes trustworthy")).toBe(true);
  });

  it("recognises word-order and spacing variants of a multi-word brand", () => {
    expect(brandTermMatches("harmonie atelier", "atelier-harmonie")).toBe(true);
    expect(brandTermMatches("l'atelier by harmonie", "atelier-harmonie")).toBe(true);
    expect(brandTermMatches("atelier harmonie", "atelier-harmonie")).toBe(true);
    expect(brandTermMatches("harmonie boutique", "atelier-harmonie")).toBe(false);
    expect(brandTermMatches("l'harmonie", "atelier-harmonie")).toBe(false);
    expect(brandTermMatches("casa migo", "casamigo")).toBe(true);
    expect(brandTermMatches("casas", "casamigo")).toBe(false);
  });

  it("keeps generic words out of an exclusive brand topic", () => {
    const brand = definition({
      slug: "casamigo-brand",
      name: "Casamigo brand",
      coverageKind: "brand",
      requireAny: ["casa migo", "casamigo homes", "casa", "migo", "casamigo"],
      terms: ["casa migo", "casamigo", "casa", "migo"],
      strongTerms: ["casamigo"],
      preferredPages: ["/"],
      exclusive: true,
    });
    const result = stabilizeTopicTaxonomy({
      topics: [brand],
      queries: [
        { query: "casa migo", impressions: 3, volume: 10 },
        { query: "casamigo homes", impressions: 1, volume: 5 },
        { query: "casas", impressions: 0, volume: 550000 },
      ],
    });
    const kept = result.topics[0];
    expect(kept.requireAny).not.toContain("casa");
    expect(kept.requireAny).not.toContain("migo");
    expect(queryMatchesTopics([kept], "casa migo")).toBe(true);
    expect(queryMatchesTopics([kept], "casas")).toBe(false);
  });
});

describe("structured membership", () => {
  const luxury = topic({
    name: "Riviera Maya luxury condos",
    market: { scope: "local", places: ["riviera maya"], localIntent: [] },
    need: { terms: ["luxury", "condos"] },
    requireAny: ["riviera maya", "luxury", "condos"],
    terms: ["luxury", "condos"],
    strongTerms: ["luxury condos"],
  }) as TopicDefinition;

  it("requires the place and the need", () => {
    expect(queryMatchesTopics([luxury], "riviera maya things to do")).toBe(false);
    expect(queryMatchesTopics([luxury], "propiedades")).toBe(false);
    expect(queryMatchesTopics([luxury], "propiedades en venta en playa del carmen")).toBe(false);
    expect(queryMatchesTopics([luxury], "riviera maya luxury condos")).toBe(true);
  });

  it("matches a local-intent phrase without naming the place", () => {
    const near = { ...luxury, market: { scope: "local" as const, places: ["riviera maya"], localIntent: ["near me"] } };
    expect(queryMatchesTopics([near], "luxury condos near me")).toBe(true);
  });

  it("has no market requirement when the topic is international", () => {
    const global = { ...luxury, market: { scope: "international" as const, places: [], localIntent: [] } };
    expect(queryMatchesTopics([global], "luxury condos")).toBe(true);
    expect(queryMatchesTopics([global], "riviera maya things to do")).toBe(false);
  });

  it("keeps a brand topic to its name", () => {
    const brand = topic({
      slug: "casamigo-brand",
      name: "Casamigo brand",
      kind: "brand",
      coverageKind: "brand",
      market: undefined,
      need: undefined,
      requireAny: ["casamigo"],
      terms: ["casamigo"],
      strongTerms: ["casamigo"],
      exclusive: true,
    }) as TopicDefinition;
    expect(queryMatchesTopics([brand], "casamigo")).toBe(true);
    expect(queryMatchesTopics([brand], "casas")).toBe(false);
    expect(queryMatchesTopics([brand], "casas de cambio")).toBe(false);
  });

  it("still honours a legacy taxonomy with no structured fields", () => {
    const legacy = topic({
      kind: undefined,
      market: undefined,
      need: undefined,
      requireAny: ["fauteuil"],
      requireGroups: [["tapissier", "tapisserie"]],
    }) as unknown as TopicDefinition;
    expect(queryMatchesTopics([legacy], "fauteuil tapissier")).toBe(true);
    expect(queryMatchesTopics([legacy], "fauteuil")).toBe(false);
  });
});

describe("taxonomy proposal", () => {
  it("stores the market and the need, not a place group", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      summary: "One topic.",
      topics: [
        {
          name: "Tulum condos",
          kind: "market",
          marketScope: "local",
          marketPlaces: ["Tulum"],
          localIntent: ["near me"],
          needTerms: ["condos", "penthouses"],
          headTerms: [],
          intent: "commercial",
          relevance: "high",
          coverageKind: "product",
          offerKey: "Condos",
          rationale: "Buyers search Tulum condos directly.",
          actionHint: "Check the listing page.",
          memberQueries: ["tulum condos for sale", "tulum condos"],
          ownerPages: ["/tulum-condos"],
        },
      ],
      pageTypeRules: [],
      excludePaths: [],
      newsQueries: [],
    }));
    const result = await proposeTopicTaxonomy(input({
      queries: [
        { query: "tulum condos for sale", impressions: 40, volume: 300 },
        { query: "tulum condos", impressions: 25, volume: 200 },
        { query: "tulum penthouses", impressions: 10, volume: 100 },
      ],
    }));
    expect(result.error).toBeNull();
    const proposed = result.taxonomy!.topics[0];
    expect(proposed.kind).toBe("market");
    expect(proposed.market).toEqual({ scope: "local", places: ["tulum"], localIntent: ["near me"] });
    expect(proposed.need).toEqual({ terms: ["condos", "penthouses"] });
    expect(proposed.need?.terms).not.toContain("tulum");
  });

  it("rejects a market topic with no need and re-proposes once", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson
      .mockImplementationOnce(async () => ({
        summary: "First pass.",
        topics: [
          {
            name: "Playa del Carmen real estate",
            kind: "market",
            marketScope: "local",
            marketPlaces: ["Playa del Carmen"],
            localIntent: [],
            needTerms: [],
            intent: "mixed",
            relevance: "high",
            coverageKind: "mixed",
            offerKey: "Condos",
            rationale: "Place demand.",
            actionHint: "Check the city page.",
            memberQueries: ["propiedades en playa del carmen"],
            ownerPages: ["/cities/playa-del-carmen"],
          },
        ],
        pageTypeRules: [],
        excludePaths: [],
        newsQueries: [],
      }))
      .mockImplementationOnce(async () => ({
        summary: "Corrected.",
        topics: [
          {
            name: "Playa del Carmen real estate",
            kind: "market",
            marketScope: "local",
            marketPlaces: ["Playa del Carmen"],
            localIntent: [],
            needTerms: ["propiedades", "real estate", "bienes raices"],
            intent: "mixed",
            relevance: "high",
            coverageKind: "mixed",
            offerKey: "Condos",
            rationale: "Place demand with a need.",
            actionHint: "Check the city page.",
            memberQueries: ["propiedades en playa del carmen"],
            ownerPages: ["/cities/playa-del-carmen"],
          },
        ],
        pageTypeRules: [],
        excludePaths: [],
        newsQueries: [],
      }));
    const result = await proposeTopicTaxonomy(input({
      queries: [
        { query: "propiedades en playa del carmen", impressions: 10, volume: 500 },
        { query: "playa del carmen", impressions: 5, volume: 200 },
      ],
      pages: [{ path: "/cities/playa-del-carmen", title: "Playa", h1: "Playa", wordCount: 600 }],
    }));
    expect(result.error).toBeNull();
    expect(mocks.chatJson).toHaveBeenCalledTimes(2);
    expect(result.taxonomy?.topics[0].need?.terms).toContain("propiedades");
  });

  it("gives the brand topic the head term the model proposed", async () => {
    mocks.chatJson.mockReset();
    mocks.chatJson.mockImplementation(async () => ({
      summary: "Brand and course.",
      topics: [
        {
          name: "Ocean School",
          kind: "brand",
          marketScope: "international",
          marketPlaces: [],
          localIntent: [],
          needTerms: ["ocean school"],
          headTerms: ["freediving"],
          intent: "mixed",
          relevance: "high",
          coverageKind: "brand",
          offerKey: "Freediving course",
          rationale: "Brand demand.",
          actionHint: "Home page.",
          memberQueries: ["ocean school"],
          ownerPages: ["/"],
        },
        {
          name: "Freediving course",
          kind: "market",
          marketScope: "international",
          marketPlaces: [],
          localIntent: [],
          needTerms: ["freediving course", "course"],
          headTerms: [],
          intent: "commercial",
          relevance: "high",
          coverageKind: "service",
          offerKey: "Freediving course",
          rationale: "Course demand.",
          actionHint: "Improve the course page.",
          memberQueries: ["freediving course"],
          ownerPages: ["/course"],
        },
      ],
      pageTypeRules: [],
      excludePaths: [],
      newsQueries: [],
    }));
    const result = await proposeTopicTaxonomy(input({
      domain: "ocean.example",
      business: {
        name: "Ocean School",
        services: ["Freediving course"],
        location: "Playa del Carmen",
        serviceArea: ["Tulum"],
        audience: null,
        differentiators: [],
        concerns: [],
      },
      queries: [
        { query: "freediving", impressions: 0, volume: 12_000 },
        { query: "freediving course", impressions: 0, volume: 1_300 },
        { query: "ocean school", impressions: 2, volume: 10 },
      ],
      pages: [
        { path: "/", title: "Ocean School", h1: "Ocean School", wordCount: 500 },
        { path: "/course", title: "Freediving course", h1: "Freediving course", wordCount: 800 },
      ],
      brandTerms: ["ocean school"],
    }));
    const brand = result.taxonomy?.topics.find((entry) => isBrandTopic(entry));
    expect(brand).toBeDefined();
    expect(brand?.headTerms).toEqual(["freediving"]);
    expect(brand?.requireAny).toEqual(["ocean school"]);
    expect(brand?.terms).not.toContain("freediving course");
  });
});
