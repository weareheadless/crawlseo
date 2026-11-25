import { describe, expect, it } from "vitest";

import { MONTHLY_TRANCHE_CLUSTERS, selectTranche, type TrancheCandidate } from "@/lib/research/monthly-tranche";

/**
 * The monthly tranche: the clusters a person can actually work this month.
 *
 * The defect it replaces, measured 2026-11-25: `draftClusterProposals` looped over every
 * cluster in batches of four with no overall bound, so susimacdonald's 24 clusters were
 * six model calls of drafting a month — and `applyOpenCap` then parked everything past
 * 100 open rows by score. So we paid to draft work that was immediately hidden, and the
 * board's shape was decided by a score threshold instead of by what anyone could do.
 *
 * The old test asserted "drafts every cluster, not the first N" and it was right about
 * one thing: a *silent* cap is the bug. What replaces it is a declared bound whose
 * deferral is reported, so nothing disappears quietly.
 */

function cluster(
  slug: string,
  over: { measuredQueries?: number; relevance?: "high" | "medium" | "low"; volume?: number } = {}
): TrancheCandidate {
  return {
    slug,
    name: slug,
    relevance: over.relevance ?? "medium",
    metrics: {
      queries: 3,
      impressions: 0,
      clicks: 0,
      volume: over.volume ?? 100,
      volumeSum: over.volume ?? 100,
      difficulty: null,
      position: null,
      aeoQuestions: 0,
      aeoCited: 0,
      measuredQueries: over.measuredQueries ?? 0,
    },
  } as TrancheCandidate;
}

describe("a month of work is a handful of clusters, and the rest are named", () => {
  it("takes the tranche and reports the deferral with a count", () => {
    const clusters = Array.from({ length: 24 }, (_, i) => cluster(`topic-${i}`));
    const result = selectTranche(clusters);
    expect(result.selected).toHaveLength(MONTHLY_TRANCHE_CLUSTERS);
    expect(result.deferred).toHaveLength(24 - MONTHLY_TRANCHE_CLUSTERS);
    expect(result.truncation).toContain(`16 of 24 clusters were deferred`);
    expect(result.truncation).toContain("re-ranked against fresh data next month");
  });

  it("reports nothing when every cluster fits, so a complete tranche is not a warning", () => {
    const result = selectTranche([cluster("a"), cluster("b")]);
    expect(result.selected).toHaveLength(2);
    expect(result.deferred).toHaveLength(0);
    expect(result.truncation).toBeNull();
  });

  it("accounts for every cluster: nothing is selected and deferred at once", () => {
    // The invariant the old code could not state: deferred is not dropped.
    const clusters = Array.from({ length: 30 }, (_, i) => cluster(`t-${i}`));
    const result = selectTranche(clusters);
    const all = [...result.selected, ...result.deferred].map((entry) => entry.slug).sort();
    expect(all).toEqual(clusters.map((entry) => entry.slug).sort());
  });
});

describe("selection is by evidence, not by position in the taxonomy", () => {
  it("prefers a cluster this site is already measured on", () => {
    // A cluster with measured reach is work with a starting position. One this site has
    // never been shown for is a hypothesis about demand — the same distinction the board
    // makes now.
    const result = selectTranche([
      cluster("unmeasured-high", { relevance: "high", volume: 9000 }),
      cluster("measured-one", { measuredQueries: 1 }),
    ]);
    expect(result.selected[0].slug).toBe("measured-one");
  });

  it("prefers more measured queries over fewer", () => {
    const result = selectTranche([cluster("two", { measuredQueries: 2 }), cluster("five", { measuredQueries: 5 })]);
    expect(result.selected.map((entry) => entry.slug)).toEqual(["five", "two"]);
  });

  it("then prefers commercial relevance, as the model rated it", () => {
    const result = selectTranche([
      cluster("low", { relevance: "low" }),
      cluster("high", { relevance: "high" }),
      cluster("medium", { relevance: "medium" }),
    ]);
    expect(result.selected.map((entry) => entry.slug)).toEqual(["high", "medium", "low"]);
  });

  it("then prefers a bigger market", () => {
    const result = selectTranche([cluster("small", { volume: 50 }), cluster("big", { volume: 5000 })]);
    expect(result.selected.map((entry) => entry.slug)).toEqual(["big", "small"]);
  });

  it("breaks ties on the slug, so two runs agree", () => {
    // A tranche that reordered between identical runs would make the monthly delta
    // unreadable.
    const a = selectTranche([cluster("zeta"), cluster("alpha")]);
    const b = selectTranche([cluster("alpha"), cluster("zeta")]);
    expect(a.selected.map((entry) => entry.slug)).toEqual(b.selected.map((entry) => entry.slug));
    expect(a.selected.map((entry) => entry.slug)).toEqual(["alpha", "zeta"]);
  });

  it("respects an explicit size, and never selects zero", () => {
    expect(selectTranche([cluster("a"), cluster("b")], { size: 1 }).selected).toHaveLength(1);
    // A size of 0 would draft nothing and say nothing was deferred; one is the floor.
    expect(selectTranche([cluster("a"), cluster("b")], { size: 0 }).selected).toHaveLength(1);
  });
});
