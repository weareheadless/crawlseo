import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dataforseo/collection", () => ({
  withResearchBudget: async (_projectId: string, input: { run: () => Promise<unknown>; costOf: (r: never) => number }) => {
    const result = await input.run();
    return { result, spentMicros: input.costOf(result as never) };
  },
}));

vi.mock("@/lib/dataforseo/client", () => ({
  executeDataForSeoOrganicSerp: vi.fn(async () => ({
    result: {
      organic: [
        { rank: 1, domain: "rival.fr", url: "https://rival.fr/abat-jour", title: "Rival abat-jour", description: "sur mesure" },
        { rank: 2, domain: "atelier-harmonie.com", url: "https://www.atelier-harmonie.com/lampes", title: "Us", description: "" },
        { rank: 3, domain: "autre.fr", url: "https://autre.fr/", title: "Autre", description: "" },
      ],
    },
    providerTaskId: "serp-1",
    costMicros: 2000,
  })),
  executeDataForSeoLabsSerpCompetitors: vi.fn(async () => ({
    result: [
      { domain: "rival.fr", keywordsCount: 14, avgPosition: 4.2, etv: 900 },
      { domain: "atelier-harmonie.com", keywordsCount: 9, avgPosition: 7, etv: 200 },
    ],
    providerTaskId: "labs-1",
    costMicros: 120,
  })),
}));

import { fetchDataForSeoCompetitorSources } from "@/lib/research/providers/dataforseo-competitor";

const input = {
  projectId: "p1",
  queries: ["abat-jour sur mesure", "tapisserie de siège", "restauration de meubles anciens"],
  domain: "atelier-harmonie.com",
  languageCode: "fr",
  locationCode: 2250,
};

describe("DataForSEO competitor research provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the competitors that rank, excluding our own domain", async () => {
    const sources = await fetchDataForSeoCompetitorSources(input);
    const serp = sources.filter((source) => source.provider === "dataforseo_serp");
    expect(serp.map((source) => source.url)).toEqual(["https://rival.fr/abat-jour", "https://autre.fr/"]);
    expect(serp[0].metadata).toMatchObject({ query: input.queries[0], rank: 1, domain: "rival.fr" });
  });

  it("returns Labs coverage for competitor domains, not for us", async () => {
    const sources = await fetchDataForSeoCompetitorSources(input);
    const labs = sources.filter((source) => source.provider === "dataforseo_labs");
    expect(labs).toHaveLength(1);
    expect(labs[0].metadata).toMatchObject({ domain: "rival.fr", keywords_count: 14, avg_position: 4.2 });
    expect(labs[0].excerpt).toContain("14 keywords");
  });

  it("dates an observation with its retrieval time so recency filtering keeps it", async () => {
    const sources = await fetchDataForSeoCompetitorSources(input);
    expect(sources.every((source) => typeof source.publishedAt === "string")).toBe(true);
    expect(sources.every((source) => !Number.isNaN(Date.parse(source.publishedAt!)))).toBe(true);
  });

  it("hashes each source so re-running the same query dedupes", async () => {
    const first = await fetchDataForSeoCompetitorSources(input);
    const second = await fetchDataForSeoCompetitorSources(input);
    expect(first.map((s) => s.contentHash).sort()).toEqual(second.map((s) => s.contentHash).sort());
  });
});
