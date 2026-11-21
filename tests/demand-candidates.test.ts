import { describe, expect, it, vi } from "vitest";

import { researchCandidateQueries, demandCandidateSince, DEMAND_CANDIDATE_WINDOW_DAYS } from "@/lib/research/demand-candidates";
import { planKeywordCandidates, RESEARCH_CANDIDATE_RESERVE_SHARE } from "@/lib/research/monthly-bundle";
import type { TopicTaxonomy } from "@/lib/research/topic-taxonomy";

/**
 * Research demand becomes paid measurement through two pure-ish steps: the
 * candidate reader and the pool merge. Both are asserted here, because a phrase
 * that research observed but the planner never buys is the loop staying broken.
 */

const taxonomy = {
  version: 1,
  proposedBy: "human",
  model: null,
  generatedAt: "2026-11-01T00:00:00.000Z",
  topics: [{
    id: "topic-lampes",
    kind: "service",
    label: "Lampes artisanales",
    intent: "commercial",
    relevance: "high",
    coverageKind: "service",
    offerKey: "lampes",
    rationale: "The offer the business sells.",
    requireAny: ["lampe", "lampes", "abat-jour"],
    terms: ["lampe", "lampes", "abat-jour"],
    pageTerms: ["lampes"],
    actionHint: "Add a page for the offer.",
  }],
  pageTypeRules: [],
  excludePaths: [],
  newsQueries: [],
  summary: null,
} as unknown as TopicTaxonomy;

const evidence = (dimensions: Record<string, unknown>, observedAt: string) => ({
  dimensions,
  observedAt: new Date(observedAt),
});

describe("research demand candidates", () => {
  it("collects the finding's phrase and its other forms, gated by the taxonomy", async () => {
    const db = {
      evidenceRecord: {
        findMany: vi.fn(async () => [
          evidence({ query: "abat jour sur mesure", demandQueries: ["lampe artisanale", "hospital near me"] }, "2026-11-20T10:00:00Z"),
          evidence({ query: "délai de livraison" }, "2026-11-19T10:00:00Z"),
        ]),
      },
    };

    const selection = await researchCandidateQueries(db as never, {
      projectId: "p1",
      siteId: "s1",
      since: demandCandidateSince(new Date("2026-11-21T00:00:00Z")),
      taxonomy,
    });

    expect(selection.candidates).toEqual(["abat jour sur mesure", "lampe artisanale"]);
    expect(selection.unclaimed).toEqual(["hospital near me", "délai de livraison"]);
    expect(selection.available).toBe(4);
    expect(selection.omitted).toBe(0);
    // The window is part of the query, not a filter applied afterwards.
    const args = (db.evidenceRecord.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0] as { where: { observedAt: { gte: Date } } };
    expect(args.where.observedAt.gte).toBeInstanceOf(Date);
  });

  it("treats every form as unclaimed while no taxonomy is approved", async () => {
    const db = { evidenceRecord: { findMany: vi.fn(async () => [evidence({ query: "lampe artisanale" }, "2026-11-20T10:00:00Z")]) } };
    const selection = await researchCandidateQueries(db as never, {
      projectId: "p1", siteId: "s1", since: demandCandidateSince(new Date("2026-11-21T00:00:00Z")), taxonomy: null,
    });
    expect(selection.candidates).toEqual([]);
    expect(selection.unclaimed).toEqual(["lampe artisanale"]);
  });

  it("deduplicates wording that differs only in case or spacing and bounds the list", async () => {
    const db = {
      evidenceRecord: {
        findMany: vi.fn(async () => [evidence({
          query: "Abat  Jour  Sur Mesure",
          demandQueries: ["abat jour sur mesure", "lampe artisanale", "abat jour artisanal"],
        }, "2026-11-20T10:00:00Z")]),
      },
    };
    const selection = await researchCandidateQueries(db as never, {
      projectId: "p1", siteId: "s1", since: demandCandidateSince(new Date("2026-11-21T00:00:00Z")), taxonomy, limit: 2,
    });
    expect(selection.candidates).toEqual(["Abat  Jour  Sur Mesure", "lampe artisanale"]);
    expect(selection.omitted).toBe(1);
  });

  it("uses a named 120-day window", () => {
    const since = demandCandidateSince(new Date("2026-11-21T00:00:00Z"));
    expect(DEMAND_CANDIDATE_WINDOW_DAYS).toBe(120);
    expect(since.toISOString()).toBe("2026-07-24T00:00:00.000Z");
  });
});

describe("keyword candidate pool", () => {
  it("reserves a share of the cap for research forms and keeps proven demand after them", () => {
    const researchClaimed = ["abat jour sur mesure", "lampe artisanale", "abat jour artisanal", "lampe en gres"];
    const inMarket = ["lampe", "lampes lyon"];
    const plan = planKeywordCandidates({ researchClaimed, inMarket, offTopic: ["hospital near me"], cap: 10 });

    // floor(10 * 0.2) = 2 forms reserved.
    expect(RESEARCH_CANDIDATE_RESERVE_SHARE).toBe(0.2);
    expect(plan.researchReserved).toBe(2);
    expect(plan.researchOmitted).toBe(2);
    expect(plan.ordered.slice(0, 2)).toEqual(["abat jour sur mesure", "lampe artisanale"]);
    expect(plan.ordered.slice(2, 4)).toEqual(inMarket);
    expect(plan.ordered.at(-1)).toBe("hospital near me");
    // Two remaining forms sit before off-topic queries: they are at least in market.
    expect(plan.ordered.indexOf("abat jour artisanal")).toBeLessThan(plan.ordered.indexOf("hospital near me"));
  });

  it("collapses a duplicate to one paid query", () => {
    const plan = planKeywordCandidates({
      researchClaimed: ["lampe artisanale"],
      inMarket: ["Lampe  Artisanale", "lampes lyon"],
      offTopic: [],
      cap: 5,
    });
    expect(plan.ordered).toEqual(["lampe artisanale", "lampes lyon"]);
  });

  it("buys nothing extra when research observed nothing", () => {
    const plan = planKeywordCandidates({ researchClaimed: [], inMarket: ["lampe"], offTopic: [], cap: 30 });
    expect(plan.ordered).toEqual(["lampe"]);
    expect(plan.researchReserved).toBe(0);
    expect(plan.researchOmitted).toBe(0);
  });
});
