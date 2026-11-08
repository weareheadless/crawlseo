import { describe, expect, it } from "vitest";

import {
  brandTermMatches,
  isBrandTopic,
  loadTopicTaxonomy,
  parseTopicTaxonomy,
  projectTopicsFromJobs,
  queryMatchesTopics,
  saveTopicTaxonomy,
  stabilizeTopicTaxonomy,
  validateTopic,
  type TopicDefinition,
} from "@/lib/research/topic-taxonomy";
import type { Job } from "@/lib/research/job-map";

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

  it("keeps two topics that share a specific owner: the model decided that", () => {
    const result = stabilizeTopicTaxonomy({ topics, queries });
    expect(result.merges).toHaveLength(0);
    expect(result.topics.map((entry) => entry.slug)).toEqual(topics.map((entry) => entry.slug));
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

describe("topic projection from jobs", () => {
  function job(overrides: Partial<Job> = {}): Job {
    return {
      slug: "buy-tulum-condo",
      statement: "I want to buy a condo in Tulum",
      who: "buyer",
      stage: "buy",
      language: "en",
      market: { scope: "local", places: ["Tulum"] },
      businessFit: "serves",
      topic: {
        name: "Tulum condos for sale",
        kind: "market",
        intent: "commercial",
        relevance: "high",
        coverageKind: "product",
        offerKey: "Listings",
        needTerms: ["tulum condos", "tulum condos for sale"],
        localIntent: ["near me"],
        actionHint: "Check the listings page.",
      },
      queries: ["tulum condos for sale"],
      page: "/tulum-condos",
      reason: "Buyers name the place and the property.",
      ...overrides,
    };
  }

  it("projects one topic per served job, with the job's page and terms", () => {
    const [topic] = projectTopicsFromJobs([job()]);
    expect(topic).toMatchObject({
      slug: "buy-tulum-condo",
      name: "Tulum condos for sale",
      jobSlug: "buy-tulum-condo",
      kind: "market",
      intent: "commercial",
      relevance: "high",
      coverageKind: "product",
      offerKey: "Listings",
      preferredPages: ["/tulum-condos"],
      market: { scope: "local", places: ["Tulum"], localIntent: ["near me"] },
      need: { terms: ["tulum condos", "tulum condos for sale"] },
      actionHint: "Check the listings page.",
    });
    expect(topic.requireAny).toEqual(["tulum condos", "tulum condos for sale"]);
    expect(topic.terms).toEqual(topic.requireAny);
  });

  it("omits a job the business does not serve and keeps a job with no page", () => {
    const topics = projectTopicsFromJobs([
      job(),
      job({ slug: "sell-home", businessFit: "does_not_serve" }),
      job({ slug: "research-market", page: null }),
    ]);
    expect(topics.map((entry) => entry.slug)).toEqual(["buy-tulum-condo", "research-market"]);
    expect(topics[1].preferredPages).toBeUndefined();
  });

  it("keeps two jobs that share one owner page", () => {
    const topics = projectTopicsFromJobs([
      job(),
      job({ slug: "buy-tulum-house", page: "/tulum-condos" }),
    ]);
    expect(topics).toHaveLength(2);
    expect(topics.map((entry) => entry.preferredPages?.[0])).toEqual(["/tulum-condos", "/tulum-condos"]);
  });
});
