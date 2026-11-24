"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { canAccessSite } from "@/lib/site/access";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { declareTrackedGrid } from "@/lib/funnel/tracked-grid";

/**
 * CMP-004's human decision: which queries this cluster is tracked on.
 *
 * Discovery proposes clusters; a person decides what to watch. This action only
 * writes the declaration (the flag on the membership) — it buys nothing and
 * charts nothing. The trend itself is read from rows we already store.
 */

async function requireSiteProject(siteId: string) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, projectId: true } });
  if (!site || !site.projectId || !canAccessSite(userId, site)) redirect("/sites");
  return { projectId: site.projectId };
}

/**
 * Declare a cluster's grid. With no `queries`, the default selection applies: the
 * cluster's own declared hub first, then the members with the most measured
 * demand. With `queries`, the person's list wins — it must be made of real
 * members, so a typo cannot create a tracked query no cluster owns.
 */
export async function declareTrackedGridAction(
  siteId: string,
  clusterSlug: string,
  queries?: string[]
): Promise<{ ok: true; tracked: string[]; untracked: number } | { ok: false; error: string }> {
  const { projectId } = await requireSiteProject(siteId);
  try {
    const result = await declareTrackedGrid(db, { projectId, clusterSlug, queries });
    revalidatePath(`/sites/${siteId}/demand`);
    revalidatePath(`/sites/${siteId}/demand/${clusterSlug}`);
    return { ok: true, tracked: result.tracked, untracked: result.untracked.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not declare the grid" };
  }
}

/**
 * Declare every cluster's grid for a project in one call.
 *
 * The issue asks for exactly this: setting the grid for all clusters of a project
 * at once, so the demand map's "Tracked" tile stops reading 0 without 540 hand
 * edits. Clusters with no members report `empty` rather than being fabricated.
 */
export async function declareAllTrackedGridsAction(
  siteId: string
): Promise<{ ok: true; declared: number; empty: number; queries: number } | { ok: false; error: string }> {
  const { projectId } = await requireSiteProject(siteId);
  try {
    const clusters = await db.demandMapCluster.findMany({
      where: { projectId, supersededAt: null },
      select: { slug: true },
      orderBy: { slug: "asc" },
    });
    let declared = 0;
    let empty = 0;
    let queries = 0;
    for (const cluster of clusters) {
      const result = await declareTrackedGrid(db, { projectId, clusterSlug: cluster.slug });
      if (result.empty) empty += 1;
      else declared += 1;
      queries += result.tracked.length;
    }
    revalidatePath(`/sites/${siteId}/demand`);
    return { ok: true, declared, empty, queries };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not declare the grids" };
  }
}
