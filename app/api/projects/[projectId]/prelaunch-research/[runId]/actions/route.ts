import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { refreshFunnelForSite } from "@/lib/funnel/backfill";

/**
 * Wave 6 cutover: this endpoint used to mint legacy Actions from a prelaunch
 * research run. The run's task results are already projected into the evidence
 * store by the worker, so the endpoint now refreshes the funnel for the
 * project's site and reports what detection produced.
 */
export async function POST(_: Request, { params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { projectId } = await params;
  const project = await db.project.findFirst({ where: { id: projectId, sites: { some: { userId } } }, select: { id: true } });
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });

  const site = await db.site.findFirst({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!site) return Response.json({ created: 0, updated: 0, reason: "No project site is available for opportunities." });

  try {
    const result = await refreshFunnelForSite(db, site.id, { detectedBy: "prelaunch-results" });
    return Response.json({ created: result.created, updated: result.updated, evidence: result.crawlEvidence + result.rankEvidence });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed to refresh opportunities" }, { status: 400 });
  }
}
