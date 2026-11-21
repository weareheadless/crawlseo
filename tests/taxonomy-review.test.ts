import { describe, expect, it } from "vitest";

import {
  isAutoApproved,
  loadTaxonomyReview,
  markTaxonomyReviewed,
  recordTaxonomyApproval,
  taxonomyNeedsReview,
} from "@/lib/research/taxonomy-review";
import type { TopicTaxonomy } from "@/lib/research/topic-taxonomy";

/**
 * An automatically approved taxonomy is usable, but a person has to be asked to
 * read it — once per version, not once per site.
 */

function fakeDb() {
  let constraints: Record<string, unknown> | null = null;
  return {
    siteProfile: {
      findUnique: async () => (constraints === null ? null : { constraints }),
      update: async (args: { data: { constraints: Record<string, unknown> } }) => {
        constraints = args.data.constraints;
        return {};
      },
      create: async (args: { data: { constraints: Record<string, unknown> } }) => {
        constraints = args.data.constraints;
        return {};
      },
    },
  };
}

const taxonomyAt = (generatedAt: string) => ({ generatedAt } as TopicTaxonomy);

describe("taxonomy review marker", () => {
  it("asks for a review right after an automatic approval", async () => {
    const db = fakeDb();
    await recordTaxonomyApproval(db as never, "s1", {
      approvedBy: "auto:site-cycle:2026-11",
      runId: "run-1",
      month: "2026-11",
      generatedAt: "2026-11-21T10:00:00.000Z",
    });

    const review = await loadTaxonomyReview(db as never, "s1");
    expect(review?.approvedBy).toBe("auto:site-cycle:2026-11");
    expect(isAutoApproved(review)).toBe(true);
    expect(taxonomyNeedsReview(taxonomyAt("2026-11-21T10:00:00.000Z"), review)).toBe(true);
  });

  it("stops asking once a person marks it reviewed", async () => {
    const db = fakeDb();
    await recordTaxonomyApproval(db as never, "s1", {
      approvedBy: "auto:site-cycle:2026-11",
      runId: "run-1",
      month: "2026-11",
      generatedAt: "2026-11-21T10:00:00.000Z",
    });
    await markTaxonomyReviewed(db as never, "s1", { reviewedBy: "user-1", now: new Date("2026-11-22T09:00:00.000Z") });

    const review = await loadTaxonomyReview(db as never, "s1");
    expect(review?.reviewedBy).toBe("user-1");
    expect(taxonomyNeedsReview(taxonomyAt("2026-11-21T10:00:00.000Z"), review)).toBe(false);
  });

  it("reopens the notice when a new taxonomy replaces the reviewed one", async () => {
    const db = fakeDb();
    await recordTaxonomyApproval(db as never, "s1", {
      approvedBy: "auto:site-cycle:2026-11",
      runId: "run-1",
      month: "2026-11",
      generatedAt: "2026-11-21T10:00:00.000Z",
    });
    await markTaxonomyReviewed(db as never, "s1", { reviewedBy: "user-1" });
    await recordTaxonomyApproval(db as never, "s1", {
      approvedBy: "auto:site-cycle:2026-12",
      runId: "run-2",
      month: "2026-12",
      generatedAt: "2026-12-21T10:00:00.000Z",
    });

    const review = await loadTaxonomyReview(db as never, "s1");
    expect(review?.reviewedAt).toBeNull();
    expect(taxonomyNeedsReview(taxonomyAt("2026-12-21T10:00:00.000Z"), review)).toBe(true);
  });

  it("does not ask for a review when no taxonomy is stored", () => {
    expect(taxonomyNeedsReview(null, null)).toBe(false);
  });
});
