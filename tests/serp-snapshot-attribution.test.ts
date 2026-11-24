import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrganicSerpResult } from "@/lib/dataforseo/client";

/**
 * CMP-001, end to end at the collector: what a snapshot records about who ranks.
 *
 * The SERP payload is supplied per test, so these are the acceptance criteria of
 * the issue expressed as data rather than prose.
 */

const executeDataForSeoOrganicSerp = vi.fn();

vi.mock("@/lib/dataforseo/client", () => ({
  executeDataForSeoKeywordOverview: vi.fn(),
  executeDataForSeoKeywordSuggestions: vi.fn(),
  executeDataForSeoRelatedKeywords: vi.fn(),
  executeDataForSeoOrganicSerp: (...args: unknown[]) => executeDataForSeoOrganicSerp(...args),
  performDataForSeoOperation: vi.fn(),
}));

vi.mock("@/lib/dataforseo/ai-visibility-adapter", () => ({ ingestAiVisibility: vi.fn() }));

// The budget ledger is a separate concern with its own tests; here it only has to
// let the call through and report a cost.
vi.mock("@/lib/connectors/service", () => ({
  projectConnectorBudget: async () => ({
    configured: true,
    allowanceMicros: "10000000",
    currency: "USD",
    period: "2026-11",
    policyRevision: 1,
    maxOperationMicros: "1000000",
  }),
  reserveProjectConnectorBudget: async () => ({ id: "res-1", status: "RESERVED" }),
  settleConnectorBudget: async () => undefined,
  ConnectorError: class ConnectorError extends Error {},
}));

type StoredRow = { id: string; dimensions: Record<string, unknown>; metrics: Record<string, { value: number }> };

function fakeDb(sink: StoredRow[]) {
  let counter = 0;
  return {
    rawProviderResponse: {
      create: async () => ({ id: "raw-1" }),
      // Provenance check inside storeEvidenceRecord: a paid record must point at a
      // raw response that recorded its cost.
      findUnique: async () => ({ costMicros: BigInt(3_600), status: "succeeded" }),
    },
    evidenceRecord: {
      upsert: async (input: { create: { dimensions: Record<string, unknown>; metrics: Record<string, { value: number }> } }) => {
        counter += 1;
        const id = `ev-${counter}`;
        sink.push({ id, dimensions: input.create.dimensions, metrics: input.create.metrics });
        return { id };
      },
    },
  };
}

function serp(items: OrganicSerpResult["organic"]): OrganicSerpResult {
  return { query: "q", checkedAt: null, itemTypes: ["organic"], organic: items, peopleAlsoAsk: [], relatedSearches: [], localPack: [] };
}

const organic = (rank: number, rankAbsolute: number, url: string) => {
  let domain = "";
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    domain = "";
  }
  return { rank, rankAbsolute, domain, title: "t", url, description: "", breadcrumb: null, websiteName: null };
};

/**
 * A live-provider item: the `url` is an opaque wrapper and the real page identity
 * is only in the breadcrumb. Verified against DataForSEO output on 2026-11-24.
 */
const wrapped = (rank: number, rankAbsolute: number, breadcrumb: string) => ({
  rank,
  rankAbsolute,
  domain: "google.com",
  title: "t",
  url: "https://google.com/goto?url=CAESgAEBxCJF11R4RKsfTYCc5yRkuPmV5zOQQuvJTAyxG_R7S8",
  description: "",
  breadcrumb,
  websiteName: null,
});

async function collect(payload: OrganicSerpResult, domain = "example.com") {
  const { collectSerpSnapshots } = await import("@/lib/dataforseo/collection");
  const stored: StoredRow[] = [];
  executeDataForSeoOrganicSerp.mockResolvedValue({
    result: payload,
    providerTaskId: "task-1",
    costMicros: 3_600,
  });
  await collectSerpSnapshots(fakeDb(stored) as never, {
    projectId: "p1",
    siteId: "s1",
    queries: ["q"],
    languageCode: "en",
    locationCode: 2840,
    domain,
  });
  return stored[0];
}

describe("collectSerpSnapshots attribution (CMP-001)", () => {
  beforeEach(() => {
    executeDataForSeoOrganicSerp.mockReset();
  });

  it("drops redirect wrappers before computing a position", async () => {
    const stored = await collect(serp([
      organic(1, 1, "https://www.google.com/goto?url=https://rival.test/a"),
      organic(2, 2, "https://rival.test/a"),
      organic(3, 3, "https://example.com/page"),
    ]));
    expect(stored.dimensions.topUrl).toBe("https://rival.test/a");
    expect(String(stored.dimensions.topUrl)).not.toContain("google.com");
    // We are the second *attributable* result, at absolute rank 3.
    expect(stored.metrics["provider:position"]?.value).toBe(3);
    expect(stored.metrics["provider:organicResults"]?.value).toBe(2);
  });

  it("records our real position and no coverage when we rank first", async () => {
    const stored = await collect(serp([
      organic(1, 1, "https://example.com/"),
      organic(2, 2, "https://rival.test/a"),
    ]));
    expect(stored.metrics["provider:position"]?.value).toBe(1);
    expect(stored.dimensions.competitorCovered).toBe("false");
  });

  it("records coverage and no position when we are absent among real results", async () => {
    const stored = await collect(serp([
      organic(1, 1, "https://a.test/"),
      organic(2, 2, "https://b.test/"),
      organic(3, 3, "https://c.test/"),
    ]));
    expect(stored.metrics["provider:position"]).toBeUndefined();
    expect(stored.dimensions.competitorCovered).toBe("true");
  });

  it("records an unobserved snapshot when every item is a wrapper", async () => {
    const stored = await collect(serp([
      organic(1, 1, "https://www.google.com/goto?url=https://a.test/"),
      organic(2, 2, "https://www.google.com/goto?url=https://b.test/"),
    ]));
    // Not "competitors cover it": the dimension is absent, which a board must read
    // as unobserved rather than as a gap.
    expect(stored.dimensions.competitorCovered).toBeUndefined();
    expect(stored.metrics["provider:position"]).toBeUndefined();
    expect(stored.dimensions.topUrl).toBeNull();
  });

  it("records an unobserved snapshot when the result set is empty", async () => {
    const stored = await collect(serp([]));
    expect(stored.dimensions.competitorCovered).toBeUndefined();
    expect(stored.dimensions.topUrl).toBeNull();
  });

  it("matches our site through a www variant and a subdomain", async () => {
    for (const url of ["https://www.example.com/x", "http://example.com/x", "https://shop.example.com/x"]) {
      executeDataForSeoOrganicSerp.mockReset();
      const stored = await collect(serp([organic(1, 1, url), organic(2, 2, "https://rival.test/a")]));
      expect(stored.metrics["provider:position"]?.value, url).toBe(1);
    }
  });

  it("does not match a lookalike domain", async () => {
    const stored = await collect(serp([
      organic(1, 1, "https://notexample.com/x"),
      organic(2, 2, "https://rival.test/a"),
    ]), "example.com");
    expect(stored.metrics["provider:position"]).toBeUndefined();
  });

  it("uses absolute rank, not the organic-only rank, for our position", async () => {
    // A shopping block sits above the organic list, so organic #1 is page #2.
    const stored = await collect(serp([
      organic(1, 2, "https://example.com/"),
      organic(2, 3, "https://rival.test/a"),
    ]));
    expect(stored.metrics["provider:position"]?.value).toBe(2);
  });

  it("counts only attributable results above us as coverage", async () => {
    // The wrapper is above us, but it is not a competitor.
    const stored = await collect(serp([
      organic(1, 1, "https://www.google.com/goto?url=https://rival.test/a"),
      organic(2, 2, "https://example.com/"),
    ]));
    expect(stored.dimensions.competitorCovered).toBe("false");
  });
});

describe("SERP request shape (CMP-001)", () => {
  it("does not ask for grouped organic results", async () => {
    // Guarded by reading the client source rather than the network: the request
    // body is built inside the client and never leaves it in tests.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/dataforseo/client.ts", "utf8")
    );
    const body = source.slice(source.indexOf("export async function executeDataForSeoOrganicSerp"));
    const head = body.slice(0, body.indexOf("dataforseoPostWithMeta"));
    expect(head).not.toContain("group_organic_results");
  });
});

/**
 * The live-provider shape, which the first implementation got wrong.
 *
 * Measured 2026-11-24 against DataForSEO: an ungrouped depth-20 FR SERP returned
 * 17–19 organic items and **every one** had `url: "https://google.com/goto?url=…"`
 * with `domain: "google.com"`. Discarding unattributable items therefore threw
 * away the entire SERP and would have recorded every query as unobserved. The
 * real identity is in the item's breadcrumb.
 */
describe("collectSerpSnapshots on the live wrapper shape (CMP-001)", () => {
  beforeEach(() => {
    executeDataForSeoOrganicSerp.mockReset();
  });

  it("recovers the real page from the breadcrumb instead of dropping it", async () => {
    const stored = await collect(serp([
      wrapped(1, 1, "https://atelier-loupiote.fr › nos-creations-lumineuses"),
      wrapped(2, 2, "https://luzeditions.com › collections › pendant-lights"),
    ]), "atelier-harmonie.com");
    expect(stored.dimensions.topUrl).toBe("https://atelier-loupiote.fr/nos-creations-lumineuses");
    expect(stored.dimensions.topDomains).toEqual(["atelier-loupiote.fr", "luzeditions.com"]);
    expect(stored.dimensions.competitorCovered).toBe("true");
    expect(stored.metrics["provider:organicResults"]?.value).toBe(2);
  });

  it("finds our position when our own result is a wrapper", async () => {
    const stored = await collect(serp([
      wrapped(1, 1, "https://luzeditions.com › collections"),
      wrapped(2, 2, "https://www.atelier-harmonie.com › lampes"),
      wrapped(3, 3, "https://masame.fr › 11-luminaires"),
    ]), "atelier-harmonie.com");
    expect(stored.metrics["provider:position"]?.value).toBe(2);
    expect(stored.dimensions.competitorCovered).toBe("true");
    expect(stored.dimensions.topUrl).toBe("https://luzeditions.com/collections");
  });

  it("is unobserved only when nothing resolves to a real host", async () => {
    const stored = await collect(serp([
      wrapped(1, 1, "google.com › goto"),
      { rank: 2, rankAbsolute: 2, domain: "google.com", title: "t", url: "https://google.com/searchviewer/x", description: "", breadcrumb: null, websiteName: null },
    ]), "atelier-harmonie.com");
    expect(stored.dimensions.competitorCovered).toBeUndefined();
    expect(stored.dimensions.topUrl).toBeNull();
  });

  it("keeps absolute rank when a feature block sits above the organic list", async () => {
    const stored = await collect(serp([
      wrapped(1, 2, "https://luzeditions.com › collections"),
      wrapped(2, 3, "https://www.atelier-harmonie.com › lampes"),
    ]), "atelier-harmonie.com");
    expect(stored.metrics["provider:position"]?.value).toBe(3);
  });
});
