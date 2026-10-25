import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { getAllOpportunities } from "@/lib/seo-opportunities";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = await params;
    const site = await db.site.findFirst({
      where: { id: siteId, userId },
      select: { userId: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const data = await getAllOpportunities(siteId);
    return Response.json(data);
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Failed" }, { status: 500 });
  }
}
