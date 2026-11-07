import { describe, expect, it } from "vitest";

import {
  applyMarketVerdicts,
  assignQuery,
  buildTopicMap,
  canonicalKeyword,
  clusterMetrics,
  distinctVolume,
  normalizeTopicText,
  pageType,
  renderTopicMapMarkdown,
  scoreTopicForQuery,
  storeTopicMap,
  type DemandQuery,
  type TopicMapData,
} from "@/lib/research/topic-map";
import type { TopicDefinition } from "@/lib/research/topic-taxonomy";
import { ATELIER_TAXONOMY } from "./fixtures/atelier-taxonomy";

const taxonomy = ATELIER_TAXONOMY;

function page(path: string, title: string, type: TopicMapData["pages"][number]["type"], wordCount = 400) {
  const text = normalizeTopicText(`${path} ${title}`);
  return {
    url: `https://atelier.example${path}`,
    path,
    title,
    description: "",
    h1: "",
    wordCount,
    type,
    text,
  };
}

function data(overrides: Partial<TopicMapData> = {}): TopicMapData {
  return {
    site: { id: "site-1", domain: "atelier.example", projectId: "proj-1" },
    taxonomy,
    pageTypeRules: [
      { type: "product", pattern: "/product-page/" },
      { type: "blog", pattern: "/post/" },
      { type: "category", pattern: "/lampes" },
      { type: "service", pattern: "/tapisserie-restauration" },
    ],
    excludePaths: ["/conditions-generales", "/livraison"],
    marketScope: { default: "local", offers: [] },
    context: { language: "fr", country: "FR" } as never,
    fields: {
      businessName: { value: "Atelier Test" },
      services: { value: ["Restauration de siège", "Restauration d'abat-jour"] },
      location: { value: "Saint-Pierre-en-Port, France" },
      serviceArea: { value: ["Normandie"] },
    },
    queries: [],
    pages: [],
    aeo: [],
    news: [],
    month: "2026-11",
    ...overrides,
  };
}

function query(value: string, impressions: number, volume: number | null = null) {
  return {
    query: value,
    impressions,
    clicks: 0,
    position: 10,
    volume,
    difficulty: null,
    observedAt: new Date("2026-11-04T00:00:00Z"),
  };
}

describe("topic assignment", () => {
  it("separates abat-jour restoration from creation", () => {
    expect(scoreTopicForQuery("réparation abat jour", taxonomy.find((topic) => topic.slug === "restauration-abat-jour")!)).toBeGreaterThan(0);
    expect(assignQuery("réparation abat jour", taxonomy)[0].topic.slug).toBe("restauration-abat-jour");
    expect(assignQuery("abat jour pagode", taxonomy)[0].topic.slug).toBe("creation-abat-jour");
  });

  it("keeps a bare head term in one topic instead of inflating two", () => {
    const assigned = assignQuery("abat-jour", taxonomy);
    expect(assigned.map((entry) => entry.topic.slug)).toEqual(["creation-abat-jour"]);
  });

  it("assigns brand queries only to the brand topic", () => {
    const assigned = assignQuery("atelier harmonie", taxonomy);
    expect(assigned.map((entry) => entry.topic.slug)).toEqual(["marque"]);
    expect(assignQuery("harmonie atelier", taxonomy).map((entry) => entry.topic.slug)).toEqual(["marque"]);
  });

  it("allows a local query to belong to the local and service topics", () => {
    const assigned = assignQuery("tapissier autour de moi", taxonomy);
    expect(assigned[0].topic.slug).toBe("local-normandie");
    expect(assigned.map((entry) => entry.topic.slug)).toContain("restauration-siege");
  });

  it("does not treat a generic atelier query as a workshop", () => {
    expect(assignQuery("atelier sainte adresse", taxonomy).some((entry) => entry.topic.slug === "kits-ateliers")).toBe(false);
    expect(assignQuery("kit lampe", taxonomy)[0].topic.slug).toBe("kits-ateliers");
  });
});

describe("topic map build", () => {
  it("maps demand to pages and reports the real gaps", () => {
    const map = buildTopicMap(
      data({
        queries: [
          query("fauteuil restauration", 40, 480),
          query("réparation abat jour", 60, 30),
          query("abat jour pagode", 50, 390),
          query("luminaire artisanal", 100),
          query("plafonnier artisanal", 90),
          query("kit lampe", 80, 110),
          query("tapissier autour de moi", 20),
          query("carte cadeau décoration le mans", 12),
        ],
        pages: [
          page("/tapisserie-restauration", "Restauration de Sièges & Création sur mesure", "service", 712),
          page("/lampes", "Créations Lumineuses Artisanales & Uniques", "category", 342),
          page("/lampes/abat-jours", "Abat-jour artisanaux uniques et faits main", "category", 150),
          page("/les-ateliers", "Ateliers DIY en Normandie", "service", 721),
          page("/gift-card", "Carte Cadeau Artisanat & Déco", "product", 334),
          page("/post/restauration-abat-jour", "L'art de la restauration : abat-jour en contrecollé", "blog", 854),
          page("/", "Atelier de l'harmonie | restauration de siege | Saint-Pierre-en-Port", "home", 698),
        ],
      }),
      taxonomy
    );

    const seat = map.clusters.find((cluster) => cluster.slug === "restauration-siege")!;
    expect(seat.coverage).toBe("strong");
    expect(seat.pages[0].url).toContain("/tapisserie-restauration");

    const restoration = map.clusters.find((cluster) => cluster.slug === "restauration-abat-jour")!;
    // The blog post is the owner, so the topic is covered; the page type is a
    // separate gap: the site still has no service landing page for it.
    expect(restoration.coverage).toBe("strong");
    expect(restoration.gaps.join(" ")).toMatch(/no service or category page/i);

    const lighting = map.clusters.find((cluster) => cluster.slug === "luminaires")!;
    expect(lighting.gaps.join(" ")).toMatch(/plafonnier/);
    expect(lighting.pages[0].url).toContain("/lampes");

    // Geography is a review judgement, not a rule in the builder: the cluster
    // reports its measured demand and leaves off-area exclusion to the AI.
    const local = map.clusters.find((cluster) => cluster.slug === "local-normandie")!;
    expect(local.metrics.queries).toBeGreaterThan(0);
    expect(local.gaps.join(" ")).not.toMatch(/le mans|sarthe|off-area/i);
  });

  it("removes out-of-market queries from demand and keeps them for audit", () => {
    const map = buildTopicMap(
      data({
        queries: [query("tapissier autour de moi", 20), query("restauration fauteuil saint-germain-en-laye", 5)],
      }),
      taxonomy
    );
    const local = map.clusters.find((cluster) => cluster.slug === "local-normandie")!;
    const before = local.metrics.impressions;
    const excluded = applyMarketVerdicts(map, [
      {
        cluster: "local-normandie",
        query: "restauration fauteuil saint-germain-en-laye",
        inMarket: false,
        reason: "Outside the configured local market.",
      },
    ]);
    expect(excluded).toBe(1);
    expect(local.queries.some((entry) => entry.query.includes("saint-germain"))).toBe(false);
    expect(local.excludedQueries[0]).toMatchObject({
      query: "restauration fauteuil saint-germain-en-laye",
      reason: "Outside the configured local market.",
    });
    expect(local.metrics.impressions).toBe(before - 5);
    expect(local.topicSummary).toContain("out-of-market");
  });

  it("scopes a verdict to its cluster so another topic keeps the query", () => {
    const map = buildTopicMap(
      data({ queries: [query("restauration fauteuil saint-germain-en-laye", 5)] }),
      taxonomy
    );
    const seat = map.clusters.find((cluster) => cluster.slug === "restauration-siege")!;
    const local = map.clusters.find((cluster) => cluster.slug === "local-normandie")!;
    const seatBefore = seat.metrics.impressions;
    applyMarketVerdicts(map, [
      {
        cluster: "local-normandie",
        query: "restauration fauteuil saint-germain-en-laye",
        inMarket: false,
        reason: "Outside the local market.",
      },
    ]);
    expect(local.queries).toHaveLength(0);
    expect(seat.metrics.impressions).toBe(seatBefore);
  });

  it("uses the tenant offer scope for local and international topics", () => {
    const map = buildTopicMap(
      data({
        marketScope: {
          default: "local",
          offers: [
            { offer: "Restauration de siège", scope: "local", markets: ["Normandie"] },
            { offer: "Lampes & luminaires", scope: "international", markets: ["France", "Europe"] },
          ],
        },
        queries: [query("fauteuil restauration", 40, 480), query("luminaire artisanal", 100)],
        pages: [
          page("/tapisserie-restauration", "Restauration de Sièges", "service", 712),
          page("/lampes", "Créations Lumineuses Artisanales", "category", 342),
        ],
      }),
      taxonomy
    );
    expect(map.clusters.find((cluster) => cluster.slug === "restauration-siege")?.marketScope).toMatchObject({
      scope: "local",
      source: "offer",
    });
    expect(map.clusters.find((cluster) => cluster.slug === "luminaires")?.marketScope).toMatchObject({
      scope: "international",
      source: "offer",
    });
  });

  it("renders a readable report with the topic table and unmapped demand", () => {
    const map = buildTopicMap(
      data({
        queries: [query("tenue sexie", 0, 18_100), query("fauteuil restauration", 40, 480)],
        pages: [page("/tapisserie-restauration", "Restauration de Sièges", "service", 712)],
      }),
      taxonomy
    );
    const markdown = renderTopicMapMarkdown(map);
    expect(markdown).toContain("# Topic map");
    expect(markdown).toContain("## Topic table");
    expect(markdown).toContain("Restauration de sièges");
    expect(markdown).toContain("tenue sexie");
    expect(markdown).toContain("off-business query");
  });
});

describe("topic map storage", () => {
  it("upserts clusters and writes memberships without a new table", async () => {
    const state: {
      clusters: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown>>;
    } = { clusters: [], evidence: [] };

    const db = {
      demandMapCluster: {
        findMany: async () => state.clusters.filter((row) => !row.supersededAt),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `cluster-${state.clusters.length + 1}`, tracked: false, supersededAt: null, ...data };
          state.clusters.push(row);
          return { id: row.id };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.clusters.find((entry) => entry.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      },
      evidenceRecord: {
        findMany: async ({
          where,
        }: {
          where: {
            kind?: string;
            supersededById?: string | null;
            dimensions?: { path?: string[]; equals?: unknown };
          };
        }) => {
          const path = where.dimensions?.path?.[0];
          const equals = where.dimensions?.equals;
          return state.evidence.filter((row) => {
            if (where.kind && row.kind !== where.kind) return false;
            if (where.supersededById === null && row.supersededById) return false;
            if (path && (row.dimensions as Record<string, unknown>)?.[path] !== equals) return false;
            return true;
          });
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.evidence.find((entry) => entry.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          const row = { id: `evidence-${state.evidence.length + 1}`, supersededById: null, ...create };
          state.evidence.push(row);
          return row;
        },
      },
      rawProviderResponse: { findUnique: async () => null },
    };

    const map = buildTopicMap(
      data({
        queries: [query("fauteuil restauration", 40, 480), query("réparation abat jour", 60, 30)],
        pages: [page("/tapisserie-restauration", "Restauration de Sièges", "service", 712)],
      }),
      taxonomy
    );

    const result = await storeTopicMap(db as never, map);
    expect(result.created).toBe(taxonomy.length);
    expect(result.memberships).toBeGreaterThan(0);
    expect(state.clusters).toHaveLength(taxonomy.length);
    expect(state.evidence.some((row) => row.kind === "keyword_universe_membership")).toBe(true);
    expect(state.evidence.some((row) => (row.dimensions as Record<string, unknown>).cluster === "restauration-siege")).toBe(true);
  });
});

describe("distinct demand", () => {
  const q = (query: string, volume: number): DemandQuery => ({
    query,
    impressions: 0,
    clicks: 0,
    position: null,
    volume,
    difficulty: null,
    observedAt: new Date("2026-11-01T00:00:00Z"),
  });

  it("treats plural and spacing variants as one query", () => {
    expect(canonicalKeyword("freediving course")).toBe(canonicalKeyword("freediving courses"));
    expect(canonicalKeyword("ocean vibes")).toBe(canonicalKeyword("oceanvibes"));
    expect(canonicalKeyword("Ocean Vibes")).toBe(canonicalKeyword("ocean-vibes"));
  });

  it("counts near-duplicates once at their own volume", () => {
    const queries = [
      q("freediving course", 1300),
      q("freediving courses", 1300),
      q("padi freediving course", 1300),
      q("freediving course near me", 390),
    ];
    // Four reported rows sum to 4,290; there are three distinct phrases.
    expect(distinctVolume(queries)).toBe(1300 + 1300 + 390);
  });

  it("reports the summed volume beside the distinct demand", () => {
    const metrics = clusterMetrics([q("ocean vibes", 1300), q("oceanvibes", 1300)]);
    expect(metrics.volume).toBe(1300);
    expect(metrics.volumeSum).toBe(2600);
  });
});

describe("topic membership", () => {
  const luxury: TopicDefinition = {
    slug: "topic",
    name: "Riviera Maya luxury condos",
    kind: "market",
    intent: "commercial",
    relevance: "high",
    coverageKind: "product",
    offerKey: "offer",
    rationale: "",
    market: { scope: "local", places: ["riviera maya"], localIntent: [] },
    need: { terms: ["luxury", "condos", "penthouses"] },
    requireAny: ["riviera maya", "luxury", "condos", "penthouses"],
    terms: ["luxury", "condos", "penthouses"],
    strongTerms: ["luxury condos"],
    pageTerms: ["luxury", "condos"],
    actionHint: "",
  };

  it("requires both the market and the need", () => {
    expect(scoreTopicForQuery("riviera maya things to do", luxury)).toBe(0);
    expect(scoreTopicForQuery("is riviera maya safe", luxury)).toBe(0);
    expect(scoreTopicForQuery("riviera maya luxury real estate", luxury)).toBeGreaterThan(0);
  });

  it("matches a local-intent phrase without the place name", () => {
    const near = { ...luxury, market: { scope: "local" as const, places: ["riviera maya"], localIntent: ["near me"] } };
    expect(scoreTopicForQuery("luxury condos near me", near)).toBeGreaterThan(0);
  });

  it("does not require a market for an international topic", () => {
    const global = { ...luxury, market: { scope: "international" as const, places: [], localIntent: [] } };
    expect(scoreTopicForQuery("luxury condos", global)).toBeGreaterThan(0);
  });

  it("keeps a brand topic to its name", () => {
    const brand: TopicDefinition = {
      ...luxury,
      slug: "brand",
      name: "Casa Migo",
      kind: "brand",
      coverageKind: "brand",
      market: undefined,
      need: undefined,
      requireAny: ["casa migo"],
      terms: ["casa migo"],
      strongTerms: ["casa migo"],
      exclusive: true,
    };
    expect(scoreTopicForQuery("casa migo", brand)).toBeGreaterThan(0);
    expect(scoreTopicForQuery("casas", brand)).toBe(0);
  });
});

describe("context-only demand", () => {
  it("counts queries that name the place but not the need", () => {
    const luxury = {
      ...taxonomy[0],
      slug: "luxury",
      name: "Riviera Maya luxury condos",
      kind: "market" as const,
      market: { scope: "local" as const, places: ["riviera maya"], localIntent: [] },
      need: { terms: ["luxury", "condos"] },
      requireAny: ["riviera maya", "luxury", "condos"],
      terms: ["luxury", "condos"],
      strongTerms: ["luxury condos"],
      preferredPages: ["/"],
    };
    const map = buildTopicMap(
      data({
        queries: [
          query("riviera maya luxury condos", 10, 50),
          query("riviera maya things to do", 20),
        ],
        pages: [page("/", "Riviera Maya", "home")],
      }),
      [luxury]
    );
    const cluster = map.clusters[0];
    expect(cluster.contextOnly.queries).toBe(1);
    expect(cluster.contextOnly.impressions).toBe(20);
    expect(cluster.contextOnly.examples).toContain("riviera maya things to do");
  });

  it("does not treat a generic local-intent phrase as the place", () => {
    const luxury = {
      ...taxonomy[0],
      slug: "luxury",
      name: "Riviera Maya luxury condos",
      kind: "market" as const,
      market: { scope: "local" as const, places: ["riviera maya"], localIntent: ["near me"] },
      need: { terms: ["luxury", "condos"] },
      requireAny: ["riviera maya", "luxury", "condos", "near me"],
      terms: ["luxury", "condos"],
      strongTerms: ["luxury condos"],
      preferredPages: ["/"],
    };
    const map = buildTopicMap(
      data({
        queries: [query("hospital near me", 500)],
        pages: [page("/", "Riviera Maya", "home")],
      }),
      [luxury]
    );
    // "near me" is not the place: it is only meaningful with the need, so a
    // hospital query is not context-only demand for a condo topic.
    expect(map.clusters[0].contextOnly.queries).toBe(0);
  });

  it("flags a topic whose vocabulary is only a place", () => {
    const placeOnly = {
      ...taxonomy[0],
      slug: "place",
      name: "Normandie",
      requireAny: ["normandie"],
      terms: ["normandie"],
      strongTerms: [],
      preferredPages: ["/"],
    };
    const map = buildTopicMap(
      data({ queries: [query("normandie", 5)], pages: [page("/", "Normandie", "home")] }),
      [placeOnly]
    );
    expect(map.clusters[0].reviewFlags).toContain("no-need-word");
  });
});

describe("page type and owner coverage", () => {
  it("does not let the home rule swallow every path", () => {
    const rules = [
      { type: "home" as const, pattern: "/" },
      { type: "category" as const, pattern: "/lampes" },
    ];
    expect(pageType("/", rules)).toBe("home");
    expect(pageType("/lampes", rules)).toBe("category");
    expect(pageType("/lampes/suspensions", rules)).toBe("category");
  });

  it("counts the owner page even when the page type is wrong", () => {
    const lampes = {
      ...taxonomy[0],
      slug: "lampes",
      name: "Lampes",
      requireAny: ["lampes"],
      terms: ["lampes"],
      strongTerms: ["lampes"],
      coverageRequireAny: ["does-not-match"],
      preferredPages: ["/lampes"],
      coverageKind: "product" as const,
    };
    const map = buildTopicMap(
      data({
        queries: [query("lampes artisanales", 10)],
        pages: [page("/lampes", "Lampes", "home", 400)],
      }),
      [lampes]
    );
    expect(map.clusters[0].coverage).not.toBe("none");
  });

  it("finds the owner when only the percent-encoding case differs", () => {
    const abatJour = {
      ...taxonomy[0],
      slug: "abat-jour",
      name: "Abat-jour",
      requireAny: ["abat jour"],
      terms: ["abat jour"],
      strongTerms: ["abat jour"],
      preferredPages: ["/post/l-art-%c3%a0-un-abat-jour"],
      coverageKind: "product" as const,
    };
    const map = buildTopicMap(
      data({
        queries: [query("abat jour", 10)],
        pages: [page("/post/l-art-%C3%A0-un-abat-jour", "L'art de l'abat-jour", "blog", 400)],
      }),
      [abatJour]
    );
    expect(map.clusters[0].coverage).not.toBe("none");
  });
});
