import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { userOwnsSite } from "@/lib/auth/research-action-access";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });

  // Wave 6 cutover: this endpoint used to write legacy actions derived from
  // other actions. It now refreshes the funnel, which is the single producer.
  try {
    return Response.json(await refreshFunnelForSite(db, siteId, { detectedBy: "sync-endpoint" }));
  } catch (error) {
    console.error("Funnel refresh error:", error);
    return Response.json({ error: "Failed to refresh opportunities" }, { status: 500 });
  }
}
