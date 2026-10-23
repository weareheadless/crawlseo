import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { syncSeoOpportunitiesToActions } from "@/lib/research/seo-actions";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  try {
    return Response.json(await syncSeoOpportunitiesToActions(siteId));
  } catch (error) {
    console.error("SEO opportunity sync error:", error);
    return Response.json({ error: "Failed to sync SEO opportunities" }, { status: 500 });
  }
}
