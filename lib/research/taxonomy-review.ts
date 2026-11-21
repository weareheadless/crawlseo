import type { PrismaClient } from "@prisma/client";

import { loadTopicTaxonomy, type TopicTaxonomy, type TopicTaxonomyDb } from "@/lib/research/topic-taxonomy";

/**
 * Who approved the stored topic taxonomy, and whether a person has looked at it.
 *
 * The taxonomy is safe to use the moment it is stored: it is a projection of the
 * reviewed job map and gates which queries get paid measurement. What is not
 * automatic is a human reading it. An `auto:` approval therefore stores a marker
 * that the UI shows as "review this", and a person acknowledges it once. A later
 * taxonomy (a new `generatedAt`) invalidates the acknowledgement, so the notice
 * comes back for the new version instead of going stale.
 */

export type TaxonomyReview = {
  /** `auto:<source>` when the model approved it; a reference when a person did. */
  approvedBy: string;
  /** The taxonomy's `generatedAt` this approval belongs to. */
  approvedAt: string;
  runId: string;
  month: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
};

type ReviewDb = Pick<PrismaClient, "siteProfile">;

function constraintsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function readConstraints(db: ReviewDb, siteId: string): Promise<Record<string, unknown>> {
  const profile = await db.siteProfile.findUnique({ where: { siteId }, select: { constraints: true } });
  return constraintsOf(profile?.constraints);
}

async function writeReview(db: ReviewDb, siteId: string, review: TaxonomyReview | null): Promise<void> {
  const profile = await db.siteProfile.findUnique({ where: { siteId }, select: { constraints: true } });
  const constraints = { ...constraintsOf(profile?.constraints) };
  if (review) constraints.taxonomyReview = review;
  else delete constraints.taxonomyReview;
  if (profile) {
    await db.siteProfile.update({ where: { siteId }, data: { constraints: constraints as never } });
  } else {
    await db.siteProfile.create({ data: { siteId, constraints: constraints as never } });
  }
}

export async function loadTaxonomyReview(db: ReviewDb, siteId: string): Promise<TaxonomyReview | null> {
  const raw = (await readConstraints(db, siteId)).taxonomyReview;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.approvedBy !== "string" || typeof row.approvedAt !== "string") return null;
  return {
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    runId: typeof row.runId === "string" ? row.runId : "",
    month: typeof row.month === "string" ? row.month : "",
    reviewedBy: typeof row.reviewedBy === "string" ? row.reviewedBy : null,
    reviewedAt: typeof row.reviewedAt === "string" ? row.reviewedAt : null,
  };
}

/**
 * Record that a taxonomy was stored. A re-run against the same generation keeps
 * an existing human acknowledgement; a new generation drops it.
 */
export async function recordTaxonomyApproval(
  db: ReviewDb,
  siteId: string,
  input: { approvedBy: string; runId: string; month: string; generatedAt: string; now?: Date }
): Promise<TaxonomyReview> {
  const existing = await loadTaxonomyReview(db, siteId);
  const sameGeneration = existing?.approvedAt === input.generatedAt;
  const review: TaxonomyReview = {
    approvedBy: input.approvedBy,
    approvedAt: input.generatedAt,
    runId: input.runId,
    month: input.month,
    reviewedBy: sameGeneration ? existing?.reviewedBy ?? null : null,
    reviewedAt: sameGeneration ? existing?.reviewedAt ?? null : null,
  };
  await writeReview(db, siteId, review);
  return review;
}

export async function markTaxonomyReviewed(
  db: ReviewDb,
  siteId: string,
  input: { reviewedBy: string; now?: Date }
): Promise<TaxonomyReview | null> {
  const review = await loadTaxonomyReview(db, siteId);
  if (!review) return null;
  const reviewed: TaxonomyReview = {
    ...review,
    reviewedBy: input.reviewedBy,
    reviewedAt: (input.now ?? new Date()).toISOString(),
  };
  await writeReview(db, siteId, reviewed);
  return reviewed;
}

/** Is there a taxonomy a person has not yet confirmed they read? */
export function taxonomyNeedsReview(taxonomy: TopicTaxonomy | null, review: TaxonomyReview | null): boolean {
  if (!taxonomy) return false;
  if (!review) return true;
  if (review.approvedAt !== taxonomy.generatedAt) return true;
  return review.reviewedAt == null;
}

export function isAutoApproved(review: TaxonomyReview | null): boolean {
  return Boolean(review?.approvedBy.startsWith("auto:"));
}


export type TaxonomyReviewState = {
  taxonomy: TopicTaxonomy | null;
  review: TaxonomyReview | null;
  /** True when a person has not yet read this version of the taxonomy. */
  needsReview: boolean;
  /** True when the stored approval was made by the model rather than a person. */
  autoApproved: boolean;
};

/** What the UI needs to decide whether to show the review notice. */
export async function taxonomyReviewState(
  db: ReviewDb & TopicTaxonomyDb,
  siteId: string
): Promise<TaxonomyReviewState> {
  const [taxonomy, review] = await Promise.all([
    loadTopicTaxonomy(db, siteId),
    loadTaxonomyReview(db, siteId),
  ]);
  return {
    taxonomy,
    review,
    needsReview: taxonomyNeedsReview(taxonomy, review),
    autoApproved: isAutoApproved(review),
  };
}
