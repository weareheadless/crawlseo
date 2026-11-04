import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeDataForSeoOrganicSerp: vi.fn() }));

vi.mock("@/lib/dataforseo/client", () => ({ executeDataForSeoOrganicSerp: mocks.executeDataForSeoOrganicSerp }));
vi.mock("@/lib/dataforseo/collection", () => ({
  withResearchBudget: vi.fn(async (_projectId: string, options: { run: () => Promise<unknown> }) => ({
    result: await options.run(),
    spentMicros: 5_000,
  })),
}));

import { fetchRedditSerpSources } from "@/lib/research/providers/reddit-serp";

/**
 * Reddit no longer permits direct reading: robots.txt disallows every crawler and
 * the Data API needs a commercial licence. The provider reads search results
 * instead, so what it returns is a snippet — citable, not quotable — and it has to
 * say so in the source itself.
 */
describe("reddit evidence from the search index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeDataForSeoOrganicSerp.mockResolvedValue({
      providerTaskId: "task-1",
      costMicros: 5_000,
      result: {
        organic: [
          { url: "https://www.reddit.com/r/vinted_france/comments/abc/x/", title: "Abat-jour qui ne tient plus", description: "Le mien ne tient plus droit depuis…", rank: 1, domain: "reddit.com" },
          { url: "https://www.reddit.com/r/bricolage/comments/def/y/", title: "Retapisser un fauteuil", description: "Première fois, des conseils ?", rank: 2, domain: "reddit.com" },
          { url: "https://www.marginalia.fr/article", title: "Un article", description: "hors sujet", rank: 3, domain: "marginalia.fr" },
          // Google returns most threads as an opaque redirect; it is not a link to
          // the discussion, so it is not evidence.
          { url: "https://google.com/goto?url=CAESqAEB6zswFTiPdnJq4GSImjbWL4U", title: "Real Talk on Region 8 : r/tulum", description: "…", rank: 4, domain: "google.com" },
        ],
      },
    });
  });

  it("asks for the threads and keeps only citable reddit URLs", async () => {
    const sources = await fetchRedditSerpSources({
      projectId: "p1",
      queries: ["abat-jour ne tient pas droit"],
      languageCode: "fr",
      locationCode: 2250,
    });
    // `site:` is accepted and ignored by the endpoint, so the query asks for the
    // threads by name and the URL filter does the restricting.
    expect(mocks.executeDataForSeoOrganicSerp).toHaveBeenCalledWith(expect.objectContaining({
      keyword: "abat-jour ne tient pas droit reddit",
    }));
    expect(sources.map((source) => source.url)).toEqual([
      "https://www.reddit.com/r/vinted_france/comments/abc/x/",
      "https://www.reddit.com/r/bricolage/comments/def/y/",
    ]);
    expect(sources[0].community).toBe("r/vinted_france");
    expect(sources[0].provider).toBe("reddit_serp");
  });

  it("marks the result as a snippet, with an observation date rather than a publication date", async () => {
    const [source] = await fetchRedditSerpSources({
      projectId: "p1",
      queries: ["abat-jour ne tient pas droit"],
      languageCode: "fr",
      locationCode: 2250,
    });
    expect(source.metadata?.source_kind).toBe("search_snippet");
    expect(source.metadata?.date_source).toBe("observed");
    expect(source.metadata?.observed_at).toBe(source.publishedAt);
    expect(source.excerpt).toBe("Le mien ne tient plus droit depuis…");
  });

  it("caps the paid searches instead of one per plan query", async () => {
    await fetchRedditSerpSources({
      projectId: "p1",
      queries: ["a", "b", "c", "d", "e"],
      languageCode: "fr",
      locationCode: 2250,
      maxQueries: 3,
    });
    expect(mocks.executeDataForSeoOrganicSerp).toHaveBeenCalledTimes(3);
  });

  it("reports a failure when every search fails, so the run can record it", async () => {
    mocks.executeDataForSeoOrganicSerp.mockRejectedValue(new Error("DATAFORSEO_TASK_40101"));
    await expect(fetchRedditSerpSources({
      projectId: "p1",
      queries: ["q"],
      languageCode: "fr",
      locationCode: 2250,
    })).rejects.toThrow("DATAFORSEO_TASK_40101");
  });
});
