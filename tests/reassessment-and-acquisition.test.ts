import { describe, expect, it, vi } from "vitest";

import { deriveClaimFromFinding, reassessLegacyFindings } from "@/lib/research/reassess-findings";
import { planAcquisition } from "@/lib/funnel/acquisition";

/**
 * Legacy reassessment (§6) and acquisition fairness (§4).
 *
 * A finding bridged before the claim contract has no verification, so a
 * contradicted premise would stay on the board until the next research run. The
 * reassessment derives only two things mechanically, and both remove work.
 */

const inventory = [
  { type: "cities", pages: 13, sample: "https://site.test/cities/tulum" },
  { type: "property", pages: 439 },
  { type: "post", pages: 16 },
];

describe("legacy claim derivation", () => {
  it("reads an absence sentence that names an existing page type", () => {
    const derived = deriveClaimFromFinding(
      "The site does not articulate a city-level entry point that would match the aggregator.",
      inventory
    );
    expect(derived.claim?.kind).toBe("missing_page_type");
    expect(derived.claim?.pageType).toBe("cities");
  });

  it("does not derive a claim from a positive sentence", () => {
    const derived = deriveClaimFromFinding("The city pages explain prices by neighbourhood.", inventory);
    expect(derived.claim).toBeNull();
  });

  it("flags research whose own sources were off-topic", () => {
    const derived = deriveClaimFromFinding(
      "Corpus de sources hors sujet. Aucune source ne documente la tapisserie de siège.",
      inventory
    );
    expect(derived.sourcesUnusable).toBe(true);
  });

  it("does not name a page type that is too rare to be a pattern", () => {
    const derived = deriveClaimFromFinding("There is no comparison page.", [
      { type: "comparison", pages: 1 },
    ]);
    // The sentence still asserts absence, so it is verified against content — but
    // it must not be turned into a claim about a specific page type.
    expect(derived.claim?.kind).toBe("absent_offering");
    expect(derived.claim?.pageType).toBeNull();
  });
});

describe("reassessment", () => {
  const findingRow = (id: string, dimensions: Record<string, string | null>) => ({
    id,
    observedAt: new Date("2026-10-01T00:00:00.000Z"),
    dimensions,
    metrics: {},
  });

  function mockDb(findings: Array<ReturnType<typeof findingRow>>) {
    const superseded: Array<{ id: string; dimensions: Record<string, unknown> }> = [];
    const db = {
      crawl: { findFirst: vi.fn(async () => ({ id: "c1", pagesFound: 40, maxPages: 500 })) },
      auditPage: {
        findMany: vi.fn(async () => [
          { url: "https://site.test/cities/tulum", title: "Tulum Market Analysis", contentText: "Tulum city market analysis and comparison of districts.", statusCode: 200 },
          { url: "https://site.test/cities/cancun", title: "Cancun Market Analysis", contentText: "Cancun city market analysis.", statusCode: 200 },
          { url: "https://site.test/cities/cozumel", title: "Cozumel Market Analysis", contentText: "Cozumel city market analysis.", statusCode: 200 },
          { url: "https://site.test/property/a", title: "A development", contentText: "A named development in Tulum.", statusCode: 200 },
        ]),
      },
      researchFinding: { findMany: vi.fn() },
      evidenceRecord: {
        findMany: vi.fn(async () => findings),
        upsert: vi.fn(async () => ({ id: "new", kind: "research_finding", projectId: "p", siteId: "s", observedAt: new Date(), observationHash: "h", supersededById: null })),
        update: vi.fn(async (args: { where: { id: string } }) => {
          superseded.push({ id: args.where.id, dimensions: {} });
          return {};
        }),
      },
      rawProviderResponse: { findUnique: vi.fn() },
    };
    return { db, superseded };
  }

  it("re-verifies a finding that has none and records the outcome", async () => {
    const { db, superseded } = mockDb([
      findingRow("f1", { theme: "City pages missing", gapSummary: "The site does not articulate a city-level entry point.", findingType: "POSITIONING_GAP" }),
    ]);
    const result = await reassessLegacyFindings(db as never, { projectId: "p", siteId: "s" });
    expect(result.updated).toBe(1);
    expect(result.contradicted).toBe(1);
    expect(superseded).toHaveLength(1);
  });

  it("leaves an already-verified finding alone", async () => {
    const { db } = mockDb([
      findingRow("f1", { theme: "Done", verification: "supported" }),
    ]);
    const result = await reassessLegacyFindings(db as never, { projectId: "p", siteId: "s" });
    expect(result.updated).toBe(0);
  });
});

describe("acquisition fairness", () => {
  const observed = Array.from({ length: 40 }, (_, index) => ({
    query: `incidental query ${index}`,
    url: "https://site.test/x",
    impressions: 1000 - index,
    clicks: 0,
    position: 9,
  }));

  it("reserves budget for customer-need queries when incidental traffic is abundant", () => {
    const plan = planAcquisition({
      observed,
      hypotheses: [{ query: "what closing costs will I pay", opportunityId: "o1" }],
      limit: 20,
    });
    expect(plan.requests.some((row) => row.reason === "research_hypothesis")).toBe(true);
  });

  it("does not pay again for a query the provider already answered with no data", () => {
    const plan = planAcquisition({
      observed: [{ query: "no volume phrase", url: "u", impressions: 50, clicks: 0, position: 9 }],
      noDataQueries: ["No Volume Phrase"],
    });
    expect(plan.requests).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain("no data");
  });
});

describe("measurement cache identity", () => {
  const db = (rows: Array<{ dimensions: Record<string, unknown>; observedAt: Date }>) => ({
    evidenceRecord: { findMany: async () => rows },
  });

  it("does not reuse a measurement bought for another market", async () => {
    const { measuredQueries } = await import("@/lib/funnel/acquisition");
    const cache = await measuredQueries(
      db([{ dimensions: { query: "abat-jour sur mesure", locale: "fr:2250" }, observedAt: new Date() }]) as never,
      "p1",
      new Date(),
      "en:2840"
    );
    expect(cache.fresh.size).toBe(0);
  });

  it("reuses a measurement bought for the same market", async () => {
    const { measuredQueries } = await import("@/lib/funnel/acquisition");
    const cache = await measuredQueries(
      db([{ dimensions: { query: "abat-jour sur mesure", locale: "fr:2250" }, observedAt: new Date() }]) as never,
      "p1",
      new Date(),
      "fr:2250"
    );
    expect(cache.fresh.has("abat-jour sur mesure")).toBe(true);
  });

  it("expires a measurement older than the TTL", async () => {
    const { measuredQueries, MEASUREMENT_TTL_DAYS } = await import("@/lib/funnel/acquisition");
    const old = new Date(Date.now() - (MEASUREMENT_TTL_DAYS + 1) * 86_400_000);
    const cache = await measuredQueries(
      db([{ dimensions: { query: "q", locale: "en:2840" }, observedAt: old }]) as never,
      "p1",
      new Date(),
      "en:2840"
    );
    expect(cache.fresh.size).toBe(0);
  });
});
