"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { markTaxonomyReviewed } from "@/lib/research/taxonomy-review";
import { requireSiteAccess } from "@/lib/site/require-access";

/**
 * A person has read the automatically approved taxonomy.
 *
 * The taxonomy is already in use; this records the human check the notice asks
 * for, so the notice does not stay on screen for a version somebody has seen.
 */
export async function markTaxonomyReviewedAction(siteId: string) {
  const { userId } = await requireSiteAccess(siteId);
  const review = await markTaxonomyReviewed(db, siteId, { reviewedBy: userId });
  if (!review) throw new Error("No taxonomy is awaiting review");
  revalidatePath(`/sites/${siteId}`);
  revalidatePath(`/sites/${siteId}/demand`);
}
